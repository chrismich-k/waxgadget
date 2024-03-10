import axios from 'axios'

export const fetchEosioTable = async ({
  api_url,
  code,
  scope,
  table,
  limit,
  from,
  upper = '',
  key_type = '',
  index_position = 1
}) => {

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

  const response = await axios.post(api_url + '/v1/chain/get_table_rows', args)
  const data = response.data
  //console.log({ response: response });
  return data
}
