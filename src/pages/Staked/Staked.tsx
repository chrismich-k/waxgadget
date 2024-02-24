import { useState, useId } from 'react'
import { useForm, SubmitHandler } from 'react-hook-form'
import { fetchEosioTable } from '@/libs/eosio.js'
import '@/index.css'
import axios from 'axios'

interface ProgressStateType {
  curNum: number
  maxNum: number
}

const useProgress = (initial: ProgressStateType) =>
  useState<ProgressStateType>(initial)
type UseProgressType = ReturnType<typeof useProgress>
type ProgressType = UseProgressType[0]
type SetProgressType = UseProgressType[1]

type Inputs = {
  templates: string | undefined
  sources_select: Array<string> | undefined
  accounts_to_exclude: string | undefined
}

function parse_accounts_string(inputstring: string | undefined): Set<string> {
  const lines = (inputstring ?? '').split(',').map((s) => s.trim())
  const accounts = new Set<string>(lines)
  return accounts
}

function is_valid_wax_name(inputstring: string) {
  return /^[a-z0-5.]{1,12}$/.test(inputstring)
}

function validate_accounts_to_exclude(inputtext: string | undefined) {
  if ((inputtext ?? '') === '') {
    return true
  }

  const names = parse_accounts_string(inputtext)
  let valid = true
  for (const name of names) {
    if (!is_valid_wax_name(name)) {
      valid = false
    }
  }
  if (!valid) {
    return 'Not valid list of wax names!'
  } else {
    return true
  }
}

function parseTemplatesString(inputstring: string | undefined) {
  const templates = new Map<string, number>()
  const lines = (inputstring ?? '').split('\n')
  for (const line of lines) {
    //console.log('line:' + line)
    const [template_id, multi] = line.split(' ')
    if (template_id) {
      if (templates.has(template_id)) {
        console.log(
          'template_id ' + template_id + ' already in list! - ignoring'
        )
      } else {
        let multi_number = 1
        try {
          multi_number = parseInt(multi, 10)
        } catch {
          multi_number = 1
        }
        if (Number.isNaN(multi_number)) {
          multi_number = 1
        }
        templates.set(template_id, multi_number)
      }
    }
  }
  //console.log(templates)
  return templates
}

const isValidTemplates = (inputstring: string | undefined) => {
  const results = parseTemplatesString(inputstring)
  return results.size > 0
}

function validateTemplates(inputText: string | undefined) {
  if (!isValidTemplates(inputText)) {
    return 'Not valid templates!'
  } else {
    return true
  }
}

function getWeightedAccounts(templates: Map<string, Map<string, number>>) {
  let result_text = ''
  templates.forEach((accounts) => {
    accounts.forEach((count, account) => {
      for (let i = 0; i < count; i += 1) {
        //console.log('template:' + template + '; account:' + account)
        result_text += account + '\n'
      }
    })
  })
  //console.log(result_text)
  return result_text
}

async function get_nc_waxdao_farms() {
  let offset = 0
  let more = true
  //let rows = [];

  const nc_types = new Set<string>(['nc.v2', 'nc.c.shared'])
  const nc_farms = new Set<string>()
  while (more === true) {
    const data = await fetchEosioTable({
      code: 'waxdaofarmer',
      scope: 'waxdaofarmer',
      table: 'farms',
      limit: 100,
      from: offset,
      index_position: 1
    })
    more = data.more === true
    offset = data.next_key
    //rows = [...rows, ...data.rows];

    for (const row of data.rows) {
      if (nc_types.has(row.farmtype)) {
        //console.log("nc-farm: " + row.farmname);
        nc_farms.add(row.farmname)
      }
    }
  }

  //console.log(nc_farms);
  return nc_farms
}

const get_owned = async (
  templates_map: Map<string | undefined, number>,
  accounts_to_exclude: Set<string>,
  templates_count: Map<string, Map<string, number>>
  //setProgress: SetProgressType,
  //setResultList: (arg0: string) => void
) => {
  // load transfers from atomic
  let page = 1
  let more = true

  while (more === true) {
    const url =
      'https://wax.api.atomicassets.io/atomicassets/v1/assets?template_id=' +
      Array.from(templates_map.keys()).join(',') +
      '&burned=false&page=' +
      page +
      '&limit=100&order=desc&sort=asset_id'
    const response = await axios.get(url)
    const data = response.data

    if (data.data.length > 0) {
      page += 1
      for (const asset of data.data) {
        // save account
        const template_id = asset.template?.template_id
        const owner = asset.owner

        if (!accounts_to_exclude.has(owner)) {
          // don't count if in excluded accounts
          // (don't rely on atomicassets filter)
          const increment = templates_map.get(template_id) ?? 0
          if (!templates_count.has(template_id)) {
            templates_count.set(template_id, new Map<string, number>())
          }
          if (!templates_count.get(template_id)?.has(owner)) {
            templates_count.get(template_id)?.set(owner, increment)
          } else {
            templates_count
              .get(template_id)
              ?.set(
                owner,
                (templates_count.get(template_id)?.get(owner) ?? 0) + increment
              )
          }
        }
      }
      //rows = [...rows, ...data.data];
    } else {
      more = false
    }
  }
  //console.log('got atomicassets owner data for ' + assets.size + ' assets')

  return
}

const get_transfers_to = async (
  to_account: string,
  accounts_to_exclude: Set<string>,
  templates_map: Map<string | undefined, number>
) => {
  // load transfers from atomic
  const assets = new Map<string, string>()
  const accounts = new Set<string>()
  let page = 1
  let more = true

  while (more === true) {
    const url =
      'https://wax.api.atomicassets.io/atomicassets/v1/transfers?recipient=' +
      to_account +
      '&template_id=' +
      Array.from(templates_map.keys()).join(',') +
      '&page=' +
      page +
      '&limit=100&order=desc&sort=created'
    const response = await axios.get(url)
    const data = response.data

    if (data.data.length > 0) {
      page += 1
      for (const transfer of data.data) {
        // save account
        if (
          !accounts.has(
            transfer.sender_name ||
              accounts_to_exclude.has(transfer.sender_name)
          )
        ) {
          accounts.add(transfer.sender_name)
        }
        for (const asset of transfer.assets) {
          if (!accounts_to_exclude.has(transfer.sender_name)) {
            assets.set(asset.asset_id.toString(), asset.template.template_id)
          }
        }
      }
      //rows = [...rows, ...data.data];
    } else {
      more = false
    }
  }
  console.log('got atomicassets data for ' + assets.size + ' assets')

  return { assets: assets, accounts: accounts }
}

const get_staked_wombatmaster = async (
  templates_map: Map<string | undefined, number>,
  assets: Map<string, string>,
  accounts: Set<string>,
  templates_count: Map<string, Map<string, number>>,
  setProgress: SetProgressType
) => {
  setProgress((prevState: ProgressType) => ({
    curNum: prevState.curNum,
    maxNum: accounts.size
  }))

  // load staked assets from wax tables
  let ac_count = 1
  for (const wax_account of accounts) {
    setProgress((prevState: ProgressType) => ({
      maxNum: prevState.maxNum,
      curNum: ac_count
    }))

    ac_count += 1
    let offset = 0
    let more = true
    while (more === true) {
      const data = await fetchEosioTable({
        code: 'wombatmaster',
        scope: '' + wax_account,
        table: 'staked',
        limit: 100,
        from: offset,
        index_position: 1
      })
      more = data.more === true
      offset = data.next_key
      //rows = [...rows, ...data.rows];

      // save number templates for account
      for (const asset of data.rows) {
        const template_id = assets.get(asset.asset_id) ?? ''
        if (templates_map.has(template_id)) {
          const increment = templates_map.get(template_id) ?? 0
          if (!templates_count.has(template_id)) {
            templates_count.set(template_id, new Map<string, number>())
          }
          if (!templates_count.get(template_id)?.has(wax_account)) {
            templates_count.get(template_id)?.set(wax_account, increment)
          } else {
            templates_count
              .get(template_id)
              ?.set(
                wax_account,
                (templates_count.get(template_id)?.get(wax_account) ?? 0) +
                  increment
              )
          }
        }
      }
    }
  }
  return { templates_count: templates_count }
}

const get_staked_waxdaofarmer = async (
  templates_map: Map<string | undefined, number>,
  assets: Map<string, string>,
  accounts: Set<string>,
  templates_count: Map<string, Map<string, number>>,
  nc_waxdao_farms: Set<string>,
  setProgress: SetProgressType
) => {
  setProgress((prevState: ProgressType) => ({
    curNum: prevState.curNum,
    maxNum: accounts.size
  }))

  // load staked assets from wax tables
  let ac_count = 1
  for (const wax_account of accounts) {
    setProgress((prevState: ProgressType) => ({
      maxNum: prevState.maxNum,
      curNum: ac_count
    }))

    //console.log("wax_account:");
    //console.log(wax_account);

    ac_count += 1
    const data = await fetchEosioTable({
      code: 'waxdaofarmer',
      scope: 'waxdaofarmer',
      table: 'stakebackup',
      limit: 100,
      from: '' + wax_account,
      upper: '' + wax_account,
      index_position: 2,
      key_type: 'name'
    })
    // save number of templates for account
    for (const farm of data.rows) {
      if (!nc_waxdao_farms.has(farm.farmname)) {
        // skip non-custodial farms
        for (const asset_id of farm.assets) {
          const template_id = assets.get(asset_id) ?? ''
          if (templates_map.has(template_id)) {
            const increment = templates_map.get(template_id) ?? 0
            if (!templates_count.has(template_id)) {
              templates_count.set(template_id, new Map<string, number>())
            }
            if (!templates_count.get(template_id)?.has(wax_account)) {
              templates_count.get(template_id)?.set(wax_account, increment)
            } else {
              templates_count
                .get(template_id)
                ?.set(
                  wax_account,
                  (templates_count.get(template_id)?.get(wax_account) ?? 0) +
                    increment
                )
            }
          }
        }
      }
    }
  }
  return { templates_count: templates_count }
}

const Staked = () => {
  const [progress, setProgress] = useProgress({ curNum: 0, maxNum: 0 })
  const [weightedAccountList, setWeightedAccountList] = useState('')
  const resultTextId = useId()
  const sourceTextId = useId()
  const [isCopied, setIsCopied] = useState(false)

  const handleCopyClick = () => {
    navigator.clipboard
      .writeText(weightedAccountList)
      .then(() => {
        setIsCopied(true)
        setTimeout(() => {
          setIsCopied(false)
        }, 1500)
      })
      .catch((err) => {
        console.log(err)
      })
  }

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<Inputs>()
  const onSubmit: SubmitHandler<Inputs> = async (data) => {
    const templates_map = parseTemplatesString(data.templates)
    const templates_count = new Map<string, Map<string, number>>()

    // add waxdao and wombatmaster to excluded account names
    const accounts_to_exclude = parse_accounts_string(data.accounts_to_exclude)
    accounts_to_exclude.add('wombatmaster')
    accounts_to_exclude.add('waxdaofarmer')

    if (data.sources_select?.includes('wombatmaster')) {
      // Staked in Wombat Dungeon Master contract "wombatmaster"
      const { assets: assets_wombatmaster, accounts: accounts_wombatmaster } =
        await get_transfers_to(
          'wombatmaster',
          accounts_to_exclude,
          templates_map
          //setProgress
          //setWeightedAccountList
        )

      await get_staked_wombatmaster(
        templates_map,
        assets_wombatmaster,
        accounts_wombatmaster,
        templates_count,
        setProgress
      )

      /*console.log('assets_wombatmaster:');
      console.log(assets_wombatmaster);
      console.log('accounts_wombatmaster:');
      console.log(accounts_wombatmaster);
      console.log('templates_count_wombatmaster:');
      console.log(templates_count_wombatmaster);*/
    }

    if (data.sources_select?.includes('waxdaofarmer')) {
      // Staked in WaxDAO contract "waxdaofarmer"

      // get non-custodial farms, in later step they need to be excluded
      const nc_waxdao_farms = await get_nc_waxdao_farms()

      const { assets: assets_waxdaofarmer, accounts: accounts_waxdaofarmer } =
        await get_transfers_to(
          'waxdaofarmer',
          accounts_to_exclude,
          templates_map
          //setProgress
          //setWeightedAccountList
        )

      await get_staked_waxdaofarmer(
        templates_map,
        assets_waxdaofarmer,
        accounts_waxdaofarmer,
        templates_count,
        nc_waxdao_farms,
        setProgress
      )

      /* console.log('assets_waxdaofarmer:');
      console.log(assets_waxdaofarmer);
      console.log('accounts_waxdaofarmer:');
      console.log(accounts_waxdaofarmer);
      console.log('templates_count_waxdaofarmer:');
      console.log(templates_count_waxdaofarmer); */
    }

    if (data.sources_select?.includes('account')) {
      // assets in any account, except wombatmaster, waxadao and optional excluded
      await get_owned(templates_map, accounts_to_exclude, templates_count)
    }

    const weighted_account_list = getWeightedAccounts(templates_count)
    setWeightedAccountList(weighted_account_list)

    //console.log('weighted_account_list:')
    //console.log(weighted_account_list)
  }

  return (
    <div className="flex h-screen items-center">
      <div className="mx-auto space-y-4">
        <form className="space-y-2" onSubmit={handleSubmit(onSubmit)}>
          <div className="w-full space-x-2">
            <label>
              <input
                {...register('sources_select', {
                  required: true
                })}
                name="sources_select"
                value="wombatmaster"
                type="checkbox"
              />
              wombatmaster
            </label>

            <label>
              <input
                {...register('sources_select', {
                  required: true
                })}
                name="sources_select"
                value="waxdaofarmer"
                type="checkbox"
              />
              waxdaofarmer
            </label>

            <label>
              <input
                {...register('sources_select', {
                  required: true
                })}
                name="sources_select"
                value="account"
                type="checkbox"
              />
              wax account
            </label>
          </div>

          <div>
            <label
              htmlFor="accounts_to_exclude"
              className="block text-sm font-medium leading-6 text-gray-900"
            >
              optional accounts to exclude, comma separated:
            </label>
            <input
              {...register('accounts_to_exclude', {
                validate: validate_accounts_to_exclude
              })}
              id="accounts_to_exclude"
              type="text"
              className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
            />
            {errors.accounts_to_exclude && (
              <div>{errors.accounts_to_exclude.message}</div>
            )}
          </div>

          <label
            htmlFor={sourceTextId}
            className="block text-sm font-medium leading-6 text-gray-900"
          >
            list of templates:
          </label>
          <textarea
            id={sourceTextId}
            defaultValue="template_id multiplikator"
            {...register('templates', {
              required: true,
              validate: validateTemplates
            })}
            rows={6}
            cols={50}
            className="block rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
          />
          {errors.templates && <div>{errors.templates.message}</div>}

          <button
            disabled={isSubmitting}
            type="submit"
            className="w-full rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            Submit
          </button>
        </form>

        <div
          className="my-50 pt-30 pb-30 bg-blue-100 border-t border-b border-blue-500 text-blue-700 px-4 py-3"
          role="alert"
        >
          {isSubmitting ? (
            <p className="text-sm">
              Processing {progress.curNum} of {progress.maxNum + 1} Wax Accounts
            </p>
          ) : (
            <p className="text-sm">&nbsp;</p>
          )}
        </div>
        <div className="mx-auto space-y-2">
          <label
            htmlFor={resultTextId}
            className="block text-sm font-medium leading-6 text-gray-900"
          >
            weighted list of owners (
            {(weightedAccountList?.split(/\r\n|\r|\n/).length ?? 0) - 1}):
          </label>
          <textarea
            id={resultTextId}
            value={weightedAccountList}
            readOnly={true}
            disabled
            className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
          />
          <button
            onClick={handleCopyClick}
            className="w-full rounded-md bg-white px-2.5 py-1.5 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
          >
            <span>{isCopied ? 'Copied!' : 'Copy'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default Staked
