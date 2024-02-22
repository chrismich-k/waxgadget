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
}

function parseTemplatesString(inputstring: string | undefined) {
  const templates = new Map<string, number>()
  const lines = (inputstring ?? '').split('\n')
  for (const line of lines) {
    console.log('line:' + line)
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
  console.log(templates)
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
  templates.forEach((accounts, template) => {
    accounts.forEach((count, account) => {
      for (let i = 0; i < count; i += 1) {
        console.log('template:' + template + '; account:' + account)
        result_text += account + '\n'
      }
    })
  })
  console.log(result_text)
  return result_text
}

const getTransfersTo = async (
  to_account: string,
  templates_map: Map<string | undefined, number>,
  setProgress: SetProgressType,
  setResultList: (arg0: string) => void
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
    console.log('data:')
    console.log(data)
    if (data.data.length > 0) {
      page += 1
      for (const transfer of data.data) {
        // save account
        if (!accounts.has(transfer.sender_name)) {
          accounts.add(transfer.sender_name)
        }
        for (const asset of transfer.assets) {
          assets.set(asset.asset_id.toString(), asset.template.template_id)
        }
      }
      //rows = [...rows, ...data.data];
    } else {
      more = false
    }
  }
  console.log('got atomicassets data for ' + assets.size + ' assets')
  setProgress((prevState: ProgressType) => ({
    curNum: prevState.curNum,
    maxNum: accounts.size
  }))

  const templates = new Map<string, Map<string, number>>()

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
          if (!templates.has(template_id)) {
            templates.set(template_id, new Map<string, number>())
          }
          if (!templates.get(template_id)?.has(wax_account)) {
            templates.get(template_id)?.set(wax_account, increment)
          } else {
            templates
              .get(template_id)
              ?.set(
                wax_account,
                (templates.get(template_id)?.get(wax_account) ?? 0) + increment
              )
          }
        }
      }
    }
  }

  const weighted_account_list = getWeightedAccounts(templates)
  setResultList(weighted_account_list)

  console.log('templates:')
  console.log(templates)

  console.log('got rest data for ' + assets.size + ' assets')
  return { assets: assets, accounts: accounts, account_counts: templates }
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
    console.log(data)
    const templates_map = parseTemplatesString(data.templates)
    const { assets, accounts, account_counts } = await getTransfersTo(
      'wombatmaster',
      templates_map,
      setProgress,
      setWeightedAccountList
    )
    console.log('assets:')
    console.log(assets)
    console.log('accounts:')
    console.log(accounts)
    console.log('account_counts:')
    console.log(account_counts)
  }

  return (
    <div className="flex h-screen items-center">
      <div className="mx-auto space-y-4">
        <form className="space-y-2" onSubmit={handleSubmit(onSubmit)}>
          <label
            htmlFor={sourceTextId}
            className="block text-sm font-medium leading-6 text-gray-900"
          >
            list of templates staked in wombatmaster:
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
