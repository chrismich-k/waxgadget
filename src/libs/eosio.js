import axios from 'axios'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const fetchEosioTable = async ({
  api_url,
  code,
  scope,
  table,
  limit,
  from,
  upper = '',
  key_type = '',
  index_position = 1,
  max_retries = 5,
}) => {

  let retries_count = 0
  let response = null
  let retries = 0;
  let success = false;
  let args = {
    code: code,
    scope: scope,
    table: table,
    json: true,
    limit: limit,
    lower_bound: from.toString()
  }
  if (typeof upper !== 'undefined') {
    args['upper_bound'] = upper.toString()
  }

  if (typeof key_type !== 'undefined') {
    args['key_type'] = key_type.toString()
  }

  if (typeof index_position !== 'undefined') {
    args['index_position'] = index_position
  }

  while (retries <= max_retries && !success) {
    console.log({"args": args})
    try {
      response = await axios.post(api_url + '/v1/chain/get_table_rows', args)
      success = true
      //console.log({ response: response });
    } catch (error) {
      console.log(error.toJSON())
      retries_count++
      retries++
      if (retries <= max_retries - 1) {
        await (sleep(5000))
      }
    }
    
    if (retries <= max_retries) {
      await (sleep(250))
    }
  }
  if (retries > max_retries) {
    console.log("Too many retries.")
    return { data: response?.data, success: false, retries: retries_count }
  }
  return { data: response?.data, success: true, retries: retries_count }
}
