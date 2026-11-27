import { useState, useId } from 'react';
import { useForm, SubmitHandler } from 'react-hook-form';
import { fetchEosioTable } from '@/libs/eosio.js';
import '@/index.css';
import endpoints_json from '@/data/endpoints.json';
const endpoints: Record<string, Record<string, string>> = endpoints_json;

import axios from 'axios';

interface ProgressStateType {
  curNum: number;
  maxNum: number;
  waxRetries: number;
  waxErrors: number;
  atomicRetries: number;
  atomicErrors: number;
  unit: string;
}

interface ReturnStatusType {
  success: boolean;
  retries: number;
}

const useProgress = (initial: ProgressStateType) => useState<ProgressStateType>(initial);
type UseProgressType = ReturnType<typeof useProgress>;
type ProgressType = UseProgressType[0];
type SetProgressType = UseProgressType[1];

type Inputs = {
  wax_api_endpoint: string | undefined;
  atomicassets_api_endpoint: string | undefined;
  templates: string | undefined;
  sources_select: Array<string> | undefined;
  accounts_to_exclude: string | undefined;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parse_accounts_string(inputstring: string | undefined): Set<string> {
  const lines = (inputstring ?? '').split(',').map((s) => s.trim());
  const accounts = new Set<string>(lines);
  return accounts;
}

function is_valid_wax_name(inputstring: string) {
  return /^[a-z0-5.]{1,12}$/.test(inputstring);
}

function validate_accounts_to_exclude(inputtext: string | undefined) {
  if ((inputtext ?? '') === '') {
    return true;
  }

  const names = parse_accounts_string(inputtext);
  let valid = true;
  for (const name of names) {
    if (!is_valid_wax_name(name)) {
      valid = false;
    }
  }
  if (!valid) {
    return 'Not valid list of wax names!';
  } else {
    return true;
  }
}

function parseTemplatesString(inputstring: string | undefined) {
  const templates = new Map<string, number>();
  const lines = (inputstring ?? '').split('\n');
  for (const line of lines) {
    //console.log('line:' + line)
    const [template_id, multi] = line.split(' ');
    if (template_id) {
      if (templates.has(template_id)) {
        console.log('template_id ' + template_id + ' already in list! - ignoring');
      } else {
        let multi_number = 1;
        try {
          multi_number = parseInt(multi, 10);
        } catch {
          multi_number = 1;
        }
        if (Number.isNaN(multi_number)) {
          multi_number = 1;
        }
        templates.set(template_id, multi_number);
      }
    }
  }
  //console.log(templates)
  return templates;
}

const isValidTemplates = (inputstring: string | undefined) => {
  const results = parseTemplatesString(inputstring);
  return results.size > 0;
};

function validateTemplates(inputText: string | undefined) {
  if (!isValidTemplates(inputText)) {
    return 'Not valid templates!';
  } else {
    return true;
  }
}

function getWeightedAccounts(templates: Map<string, Map<string, number>>) {
  let result_text = '';
  templates.forEach((accounts) => {
    accounts.forEach((count, account) => {
      for (let i = 0; i < count; i += 1) {
        //console.log('template:' + template + '; account:' + account)
        result_text += account + '\n';
      }
    });
  });
  //console.log(result_text)
  return result_text;
}

async function get_nc_waxdao_farms(api_url: string) {
  let offset = 0;
  let more = true;
  let error = false;
  let retries_count = 0;
  //let rows = [];

  const nc_types = new Set<string>(['nc.v2', 'nc.c.shared']);
  const nc_farms = new Set<string>();
  while (more === true && !error) {
    let success = false;
    let data = null;
    const max_retries = 5;
    let retries = 0;
    while (retries <= max_retries && !success) {
      ({ data, success } = await fetchEosioTable({
        api_url: api_url,
        code: 'waxdaofarmer',
        scope: 'waxdaofarmer',
        table: 'farms',
        limit: 100,
        from: offset,
        index_position: 1,
        max_retries: 0,
      }));
      if (!success) {
        retries += 1;
      }
    }
    retries_count += retries;
    if (!success || !data) {
      // give up: without the full farm list non-custodial farms can't be excluded reliably
      error = true;
      break;
    }
    more = data.more === true;
    offset = data.next_key;
    //rows = [...rows, ...data.rows];

    for (const row of data.rows) {
      if (nc_types.has(row.farmtype)) {
        //console.log("nc-farm: " + row.farmname);
        nc_farms.add(row.farmname);
      }
    }
  }

  //console.log(nc_farms);
  return { data: nc_farms, success: !error, retries: retries_count };
}

const get_owned = async (
  api_url: string,
  templates_map: Map<string | undefined, number>,
  accounts_to_exclude: Set<string>,
  templates_count: Map<string, Map<string, number>>,
  setProgress: SetProgressType,
  api_delay = 100
  //setResultList: (arg0: string) => void
) => {
  // load transfers from atomic

  // we need to query data in chunks of max <template_chunk_length> query_ids from atomic
  const template_chunk_length = 5;
  let map_chunk_counter = 0;
  let map_counter = 0;

  let template_ids_chunk: (string | undefined)[] = [];

  for (const template_id of templates_map.keys()) {
    if (map_chunk_counter === template_chunk_length - 1 || map_counter === templates_map.size - 1) {
      template_ids_chunk.push(template_id);
      console.log('chunk:');
      console.log(template_ids_chunk);

      setProgress((prevState: ProgressType) => ({
        ...prevState,
        curNum: map_counter + 1,
        maxNum: templates_map.size,
        unit: 'Templates from all accounts',
      }));

      let insert_account_count = 0;
      let insert_asset_count = 0;

      // get chunk of max <template_chunk_length> template_ids from atomicassets
      let page = 1;
      let more = true;

      while (more === true) {
        const url =
          api_url +
          '/atomicassets/v1/assets?template_id=' +
          template_ids_chunk
            .filter(function (x) {
              return x !== undefined;
            })
            .join(',') +
          '&burned=false&page=' +
          page +
          '&limit=100&order=desc&sort=asset_id';
        const response = await axios.get(url);

        // wait a bit, to not get blocked
        await sleep(api_delay);

        const data = response.data;

        if (data.data.length > 0) {
          page += 1;
          for (const asset of data.data) {
            // save account
            const template_id = asset.template?.template_id;
            const owner = asset.owner;

            if (!accounts_to_exclude.has(owner)) {
              // don't count if in excluded accounts
              // (don't rely on atomicassets filter)
              const increment = templates_map.get(template_id) ?? 0;
              if (!templates_count.has(template_id)) {
                templates_count.set(template_id, new Map<string, number>());
              }
              if (!templates_count.get(template_id)?.has(owner)) {
                templates_count.get(template_id)?.set(owner, increment);
                insert_asset_count += 1;
              } else {
                templates_count
                  .get(template_id)
                  ?.set(owner, (templates_count.get(template_id)?.get(owner) ?? 0) + increment);
                insert_asset_count += 1;
                insert_account_count += 1;
              }
            }
          }
          //rows = [...rows, ...data.data];
        } else {
          more = false;
        }
      }
      console.log('insert_account_count:');
      console.log(insert_account_count);
      console.log('insert_asset_count:');
      console.log(insert_asset_count);

      // finish processing chunk
      more = true;
      map_counter += 1;
      map_chunk_counter = 0;
      template_ids_chunk = [];
    } else {
      // only add next template to chunk
      template_ids_chunk.push(template_id);
      map_counter += 1;
      map_chunk_counter += 1;
    }
  }
  //console.log('got atomicassets owner data for ' + assets.size + ' assets')

  return;
};

const get_transfers_to = async (
  api_url: string,
  to_account: string,
  accounts_to_exclude: Set<string>,
  templates_map: Map<string | undefined, number>,
  setProgress: SetProgressType,
  unit_name: string
) => {
  // load transfers from atomic
  const assets = new Map<string, string>();
  const accounts = new Set<string>();

  // we need to query data in chunks of max <template_chunk_length> query_ids from atomic
  const template_chunk_length = 5;
  let map_chunk_counter = 0;
  let map_counter = 0;

  let template_ids_chunk: (string | undefined)[] = [];

  for (const template_id of templates_map.keys()) {
    if (map_chunk_counter === template_chunk_length - 1 || map_counter === templates_map.size - 1) {
      template_ids_chunk.push(template_id);
      console.log('chunk:');
      console.log(template_ids_chunk);

      setProgress((prevState: ProgressType) => ({
        ...prevState,
        curNum: map_counter + 1,
        maxNum: templates_map.size,
        unit: 'Templates for ' + unit_name + ' from atomic API',
      }));

      let insert_account_count = 0;
      let insert_asset_count = 0;

      // get chunk of max <template_chunk_length> template_ids from atomicassets
      let page = 1;
      let more = true;

      while (more === true) {
        const url =
          api_url +
          '/atomicassets/v1/transfers?recipient=' +
          to_account +
          '&template_id=' +
          template_ids_chunk
            .filter(function (x) {
              return x !== undefined;
            })
            .join(',') +
          '&page=' +
          page +
          '&limit=100&order=desc&sort=created';
        const response = await axios.get(url);
        const data = response.data;

        console.log('data.data:');
        console.log(data.data);

        if (data.data.length > 0) {
          page += 1;
          for (const transfer of data.data) {
            // save account
            if (!accounts.has(transfer.sender_name) && !accounts_to_exclude.has(transfer.sender_name)) {
              accounts.add(transfer.sender_name);
              insert_account_count += 1;
            }
            for (const asset of transfer.assets) {
              if (!accounts_to_exclude.has(transfer.sender_name)) {
                assets.set(asset.asset_id.toString(), asset.template.template_id);
                insert_asset_count += 1;
              }
            }
          }
          //rows = [...rows, ...data.data];
        } else {
          more = false;
        }
      }
      console.log('insert_account_count:');
      console.log(insert_account_count);
      console.log('insert_asset_count:');
      console.log(insert_asset_count);

      // finish processing chunk
      more = true;
      map_counter += 1;
      map_chunk_counter = 0;
      template_ids_chunk = [];
    } else {
      // only add next template to chunk
      template_ids_chunk.push(template_id);
      map_counter += 1;
      map_chunk_counter += 1;
    }
  }

  console.log('got atomicassets data for ' + assets.size + ' assets');

  return { assets: assets, accounts: accounts };
};

const get_staked_wombatmaster = async (
  api_url: string,
  templates_map: Map<string | undefined, number>,
  assets: Map<string, string>,
  accounts: Set<string>,
  templates_count: Map<string, Map<string, number>>,
  setProgress: SetProgressType
): Promise<ReturnStatusType> => {
  let error = false;
  let retries_count = 0;
  let api_count = 0;

  setProgress((prevState: ProgressType) => ({
    ...prevState,
    curNum: 1,
    maxNum: accounts.size,
    unit: 'DM accounts',
  }));

  // load staked assets from wax tables
  let ac_count = 1;
  for (const wax_account of accounts) {
    // let api_count = 0
    setProgress((prevState: ProgressType) => ({
      ...prevState,
      curNum: ac_count,
      unit: 'DM accounts (' + wax_account + ')',
    }));

    ac_count += 1;
    let offset = 0;
    let more = true;
    let data = null;
    let success = false;
    while (more === true && !error) {
      let next_offset = 0;
      let processed_assets = 0;
      success = false;

      //console.log("more: " + more + "; error: " + error + "; wax_account: " + wax_account + "; offset: " + offset)

      let retries = 0;
      api_count += 1;
      const max_retries = 5;
      while (retries <= max_retries && !success) {
        //console.log("retries: " + retries);
        //console.log("wax_account: " + wax_account);
        //console.log("from: " + offset);

        ({ data, success } = await fetchEosioTable({
          api_url: api_url,
          code: 'wombatmaster',
          scope: '' + wax_account,
          table: 'staked',
          limit: 100,
          from: offset,
          index_position: 1,
          max_retries: 0,
        }));

        //console.log("data: " + JSON.stringify(data, null, '\t'));

        if (!success) {
          setProgress((prevState: ProgressType) => ({
            ...prevState,
            waxRetries: prevState.waxRetries + 1,
            unit: 'DM accounts (' + wax_account + ')',
          }));
          console.log('unsuccessful');
          retries += 1;
          await sleep(1000);
        } else {
          //console.log("success - data: " + JSON.stringify(data, null, '\t'));
        }
      }
      more = data?.more === true;
      error = !success;
      retries_count += retries;
      if (more && success) {
        next_offset = data?.next_key;

        //console.log("new offset: " + offset)
      }
      //rows = [...rows, ...data.rows];

      // save number templates for account
      try {
        //console.log("try");

        for (const asset of data?.rows) {
          //console.log("asset: " + JSON.stringify(asset, null, '\t'));

          const template_id = assets.get(asset.asset_id) ?? '';
          if (templates_map.has(template_id)) {
            const increment = templates_map.get(template_id) ?? 0;
            if (!templates_count.has(template_id)) {
              templates_count.set(template_id, new Map<string, number>());
            }
            if (!templates_count.get(template_id)?.has(wax_account)) {
              templates_count.get(template_id)?.set(wax_account, increment);
            } else {
              templates_count
                .get(template_id)
                ?.set(wax_account, (templates_count.get(template_id)?.get(wax_account) ?? 0) + increment);
            }
          }
          processed_assets += 1;
        }

        console.log('processed ' + processed_assets + ' assets for ' + wax_account + '; offset: ' + offset);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.log('error: ' + err.message);
        }
      }

      data = null;
      offset = next_offset;

      //await(sleep(1000));
    }
  }
  return { success: !error, retries: retries_count };
};

const get_staked_waxdaofarmer = async (
  api_url: string,
  templates_map: Map<string | undefined, number>,
  assets: Map<string, string>,
  accounts: Set<string>,
  templates_count: Map<string, Map<string, number>>,
  nc_waxdao_farms: Set<string>,
  setProgress: SetProgressType
): Promise<ReturnStatusType> => {
  setProgress((prevState: ProgressType) => ({
    ...prevState,
    curNum: 1,
    maxNum: accounts.size,
    unit: 'WaxDAO accounts',
  }));
  const stakebackup_limit = 1000;
  let error = false;
  let retries_count = 0;

  // load staked assets from wax tables
  let ac_count = 1;
  for (const wax_account of accounts) {
    setProgress((prevState: ProgressType) => ({
      ...prevState,
      curNum: ac_count,
    }));

    //console.log("wax_account: " + wax_account);
    //console.log(wax_account);

    ac_count += 1;
    const { data, success, retries } = await fetchEosioTable({
      api_url: api_url,
      code: 'waxdaofarmer',
      scope: 'waxdaofarmer',
      table: 'stakebackup',
      // all rows of one account share the same secondary key, so paging via
      // next_key is not reliable - fetch everything at once instead
      limit: stakebackup_limit,
      from: '' + wax_account,
      upper: '' + wax_account,
      index_position: 2,
      key_type: 'name',
    });

    retries_count += retries;
    if (retries > 0) {
      setProgress((prevState: ProgressType) => ({
        ...prevState,
        waxRetries: prevState.waxRetries + retries,
      }));
    }

    if (!success || !data) {
      console.log('waxdaofarmer: failed to load stakebackup rows for ' + wax_account);
      error = true;
      setProgress((prevState: ProgressType) => ({
        ...prevState,
        waxErrors: prevState.waxErrors + 1,
      }));
      break;
    }

    if (data.more === true) {
      // result would be truncated - don't silently count only part of the stakes
      console.log(
        'waxdaofarmer: more than ' + stakebackup_limit + ' stakebackup rows for ' + wax_account + ', aborting'
      );
      error = true;
      setProgress((prevState: ProgressType) => ({
        ...prevState,
        waxErrors: prevState.waxErrors + 1,
      }));
      break;
    }

    // save number of templates for account
    for (const farm of data.rows ?? []) {
      if (!nc_waxdao_farms.has(farm.farmname)) {
        // skip non-custodial farms
        for (const asset_id of farm.assets) {
          const template_id = assets.get(asset_id) ?? '';
          if (templates_map.has(template_id)) {
            const increment = templates_map.get(template_id) ?? 0;
            if (!templates_count.has(template_id)) {
              templates_count.set(template_id, new Map<string, number>());
            }
            if (!templates_count.get(template_id)?.has(wax_account)) {
              templates_count.get(template_id)?.set(wax_account, increment);
            } else {
              templates_count
                .get(template_id)
                ?.set(wax_account, (templates_count.get(template_id)?.get(wax_account) ?? 0) + increment);
            }
          }
        }
      }
    }
  }
  return { success: !error, retries: retries_count };
};

const Staked = () => {
  const [progress, setProgress] = useProgress({
    curNum: 0,
    maxNum: 0,
    waxRetries: 0,
    waxErrors: 0,
    atomicRetries: 0,
    atomicErrors: 0,
    unit: '',
  });
  const [weightedAccountList, setWeightedAccountList] = useState('');
  const resultTextId = useId();
  const sourceTextId = useId();
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyClick = () => {
    navigator.clipboard
      .writeText(weightedAccountList)
      .then(() => {
        setIsCopied(true);
        setTimeout(() => {
          setIsCopied(false);
        }, 1500);
      })
      .catch((err) => {
        console.log(err);
      });
  };

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Inputs>({ defaultValues: { wax_api_endpoint: 'EOSAmsterdam', atomicassets_api_endpoint: 'NeftyGuild' } });
  const onSubmit: SubmitHandler<Inputs> = async (data) => {
    console.log({ data: data });
    const templates_map = parseTemplatesString(data.templates);
    const templates_count = new Map<string, Map<string, number>>();
    let wax_error = false;
    let aa_error = false;
    let wax_retries = 0;
    //let aa_retries = 0

    setProgress({
      curNum: 0,
      maxNum: 0,
      waxRetries: 0,
      waxErrors: 0,
      atomicRetries: 0,
      atomicErrors: 0,
      unit: '',
    });

    // add waxdao and wombatmaster to excluded account names
    const accounts_to_exclude = parse_accounts_string(data.accounts_to_exclude);
    accounts_to_exclude.add('wombatmaster');
    accounts_to_exclude.add('waxdaofarmer');

    if (data.sources_select?.includes('wombatmaster') && !wax_error && !aa_error) {
      // Staked in Wombat Dungeon Master contract "wombatmaster"
      const { assets: assets_wombatmaster, accounts: accounts_wombatmaster } = await get_transfers_to(
        endpoints.atomic_https[data.atomicassets_api_endpoint ?? ''],
        'wombatmaster',
        accounts_to_exclude,
        templates_map,
        setProgress,
        'Dungeon Master'
      );

      const { success, retries } = await get_staked_wombatmaster(
        endpoints.api_https2[data.wax_api_endpoint ?? ''],
        templates_map,
        assets_wombatmaster,
        accounts_wombatmaster,
        templates_count,
        setProgress
      );
      wax_error = wax_error || !success;
      wax_retries += retries;

      /*console.log('assets_wombatmaster:');
      console.log(assets_wombatmaster);
      console.log('accounts_wombatmaster:');
      console.log(accounts_wombatmaster);
      console.log('templates_count_wombatmaster:');
      console.log(templates_count_wombatmaster);*/
    }

    if (data.sources_select?.includes('waxdaofarmer') && !wax_error && !aa_error) {
      // Staked in WaxDAO contract "waxdaofarmer"

      // get non-custodial farms, in later step they need to be excluded
      const {
        data: nc_waxdao_farms,
        success: nc_success,
        retries: nc_retries,
      } = await get_nc_waxdao_farms(endpoints.api_https2[data.wax_api_endpoint ?? '']);
      wax_error = wax_error || !nc_success;
      wax_retries += nc_retries;
      setProgress((prevState: ProgressType) => ({
        ...prevState,
        waxRetries: prevState.waxRetries + nc_retries,
        waxErrors: prevState.waxErrors + (nc_success ? 0 : 1),
      }));

      // without the complete farm list, non-custodial farms can't be excluded - skip
      if (nc_success) {
        const { assets: assets_waxdaofarmer, accounts: accounts_waxdaofarmer } = await get_transfers_to(
          endpoints.atomic_https[data.atomicassets_api_endpoint ?? ''],
          'waxdaofarmer',
          accounts_to_exclude,
          templates_map,
          setProgress,
          'WaxDAO'
        );

        const { success, retries } = await get_staked_waxdaofarmer(
          endpoints.api_https2[data.wax_api_endpoint ?? ''],
          templates_map,
          assets_waxdaofarmer,
          accounts_waxdaofarmer,
          templates_count,
          nc_waxdao_farms,
          setProgress
        );
        wax_error = wax_error || !success;
        wax_retries += retries;
      }

      /* console.log('assets_waxdaofarmer:');
      console.log(assets_waxdaofarmer);
      console.log('accounts_waxdaofarmer:');
      console.log(accounts_waxdaofarmer);
      console.log('templates_count_waxdaofarmer:');
      console.log(templates_count_waxdaofarmer); */
    }

    if (data.sources_select?.includes('account') && !wax_error && !aa_error) {
      // assets in any account, except wombatmaster, waxadao and optional excluded
      await get_owned(
        endpoints.atomic_https[data.atomicassets_api_endpoint ?? ''],
        templates_map,
        accounts_to_exclude,
        templates_count,
        setProgress
      );
    }

    const weighted_account_list = getWeightedAccounts(templates_count);
    setWeightedAccountList(weighted_account_list);

    //console.log('weighted_account_list:')
    //console.log(weighted_account_list)
  };

  let wax_error = '';
  if (progress.waxRetries > 0) {
    wax_error = 'WAX API: ' + progress.waxRetries.toString() + 'x Retries';
  }
  if (progress.waxErrors > 0) {
    wax_error = 'WAX API: ERROR!';
  }

  let aa_error = '';
  if (progress.atomicRetries > 0) {
    aa_error = 'AtomicAssets API: ' + progress.atomicRetries.toString() + 'x Retries';
  }
  if (progress.atomicErrors > 0) {
    aa_error = 'AtomicAssets API: ERROR!';
  }

  return (
    <div className="m-4 flex h-screen items-center">
      <div className="mx-auto space-y-4">
        <form className="space-y-2" onSubmit={handleSubmit(onSubmit)}>
          <div className="w-full space-x-2">
            <label>
              <input
                {...register('sources_select', {
                  required: true,
                })}
                name="sources_select"
                value="wombatmaster"
                type="checkbox"
                className="mr-1"
              />
              wombatmaster
            </label>

            <label>
              <input
                {...register('sources_select', {
                  required: true,
                })}
                name="sources_select"
                value="waxdaofarmer"
                type="checkbox"
                className="mr-1"
              />
              waxdaofarmer
            </label>

            <label>
              <input
                {...register('sources_select', {
                  required: true,
                })}
                name="sources_select"
                value="account"
                type="checkbox"
                className="mr-1"
              />
              wax account
            </label>
          </div>

          <div>
            <label htmlFor={sourceTextId} className="block text-sm font-medium leading-6 text-gray-900">
              list of templates:
            </label>
            <textarea
              id={sourceTextId}
              defaultValue="template_id multiplikator"
              {...register('templates', {
                required: true,
                validate: validateTemplates,
              })}
              rows={6}
              cols={50}
              className="block rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
            />
            {errors.templates && <div>{errors.templates.message}</div>}
          </div>

          <details>
            <summary>optional settings</summary>
            <div>
              <label htmlFor="accounts_to_exclude" className="block text-sm font-medium leading-6 text-gray-900">
                accounts to exclude, comma separated:
              </label>
              <input
                {...register('accounts_to_exclude', {
                  validate: validate_accounts_to_exclude,
                })}
                id="accounts_to_exclude"
                type="text"
                className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
              />
              {errors.accounts_to_exclude && <div>{errors.accounts_to_exclude.message}</div>}
            </div>

            <div className="flex flex-row space-x-4 mb-2">
              <div className="basis-1/2 flex items-center justify-start">
                <label htmlFor="select_wax_api" className="text-sm font-medium text-gray-900">
                  WAX API endpoint:
                </label>
              </div>
              <div className="basis-1/2">
                <select
                  {...register('wax_api_endpoint')}
                  id="select_wax_api"
                  className="w-full text-sm font-medium bg-transparent border-0 border-b-2 focus:outline-none focus:ring-0 focus:border-0 focus:border-b-2"
                >
                  {Object.keys(endpoints.api_https2).map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex flex-row space-x-4">
              <div className="basis-1/2 inline-block flex items-center justify-start">
                <label htmlFor="select_atomicassets_api" className="text-sm font-medium text-gray-900">
                  AtomicAssets API endpoint:
                </label>
              </div>
              <div className="basis-1/2">
                <select
                  {...register('atomicassets_api_endpoint')}
                  id="select_atomicassets_api"
                  className="w-full text-sm font-medium bg-transparent border-0 border-b-2 focus:outline-none focus:ring-0 "
                >
                  {Object.keys(endpoints.atomic_https).map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </details>

          <button
            disabled={isSubmitting}
            type="submit"
            className="w-full rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            Submit
          </button>
        </form>

        <div
          className="my-5 pt-30 pb-30 bg-blue-100 border-t border-b border-blue-500 text-blue-700 px-4 py-3"
          role="alert"
        >
          {isSubmitting ? (
            <p className="text-sm">
              Processing {progress.curNum} of {progress.maxNum} {progress.unit} Wax retries: {progress.waxRetries}
            </p>
          ) : (
            <p className="text-sm">&nbsp;</p>
          )}
        </div>
        <div className="mx-auto space-y-2">
          <div>
            <label htmlFor={resultTextId} className="block text-sm font-medium leading-6 text-gray-900">
              results ({(weightedAccountList?.split(/\r\n|\r|\n/).length ?? 0) - 1}) {wax_error} {aa_error}:
            </label>
            <textarea
              id={resultTextId}
              value={weightedAccountList}
              readOnly={true}
              disabled
              className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
            />
          </div>
          <button
            onClick={handleCopyClick}
            className="w-full rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            <span>{isCopied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default Staked;
