const soap = require('soap');

const PORT = Number(process.env.PORT || 8000);
const endpoint = `http://localhost:${PORT}/soap`;

async function main() {
  const [, , operation, ...args] = process.argv;
  const client = await soap.createClientAsync(`${endpoint}?wsdl`);
  client.setEndpoint(endpoint);

  if (operation === 'valutes') {
    const [response] = await client.getValutesAsync({});
    console.log(JSON.stringify(
      JSON.parse(response.getValutesResult),
      null,
      2
    ));
    return;
  }

  if (operation === 'valute') {
    const [code, fromDate, toDate] = args;
    if (!code || !fromDate || !toDate) {
      throw new Error(
        'Формат: npm run client -- valute R01010 2023-03-01 2023-03-15'
      );
    }

    const parsedFromDate = new Date(fromDate);
    const parsedToDate = new Date(toDate);
    if (Number.isNaN(parsedFromDate.getTime()) ||
        Number.isNaN(parsedToDate.getTime())) {
      throw new Error('Укажите корректные даты в формате ГГГГ-ММ-ДД');
    }
    if (parsedFromDate > parsedToDate) {
      throw new Error('Дата начала не может быть позже даты окончания');
    }

    const [response] = await client.getValuteAsync({
      code,
      fromDate: parsedFromDate.toISOString(),
      toDate: parsedToDate.toISOString()
    });

    console.log(JSON.stringify(
      JSON.parse(response.getValuteResult),
      null,
      2
    ));
    return;
  }

  throw new Error(
    'Операции: valutes или valute <код> <дата-начала> <дата-конца>'
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});