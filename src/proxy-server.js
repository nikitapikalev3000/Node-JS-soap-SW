const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const soap = require('soap');

const CBR_WSDL = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx?WSDL';
const PORT = Number(process.env.PORT || 8000);
const PROXY_NAMESPACE = 'http://localhost:8000/cbr-proxy';

function text(value) {
  if (value == null) return '';
  if (typeof value === 'object' && '_' in value) {
    return text(value._);
  }
  if (typeof value === 'object' && '$value' in value) {
    return text(value.$value);
  }
  return String(value).trim();
}

function number(value) {
  const result = Number(text(value).replace(',', '.'));
  return Number.isFinite(result) ? result : undefined;
}

function extractRows(obj) {
  let rows = [];
  if (Array.isArray(obj)) {
    for (const item of obj) rows = rows.concat(extractRows(item));
  } else if (obj && typeof obj === 'object') {
    if ('Vcode' in obj || 'ValuteCode' in obj || 'CursDate' in obj) {
      rows.push(obj);
    } else {
      for (const key in obj) {
        rows = rows.concat(extractRows(obj[key]));
      }
    }
  }
  return rows;
}

function currenciesFrom(enumResponse, ratesResponse) {
  const enumResult = enumResponse.EnumValutesXMLResult;
  const ratesResult = ratesResponse.GetCursOnDateXMLResult;

  if (!enumResult || !ratesResult) {
    throw new Error('В SOAP-ответе ЦБ отсутствуют ожидаемые результаты');
  }

  const ratesRows = extractRows(ratesResult);
  const enumRows = extractRows(enumResult);

  const ratesByCode = new Map();
  for (const row of ratesRows) {
    const code = text(row.Vcode || row.ValuteCode);
    const rate = number(row.Vcurs || row.Curs || row.VunitRate);
    if (code && rate !== undefined) {
      ratesByCode.set(code, rate);
    }
  }

  const currencies = [];
  for (const row of enumRows) {
    const code = text(row.Vcode || row.ValuteCode);
    const name = text(row.Vname || row.ValuteName);
    const value = ratesByCode.get(code);
    
    if (code && name && value !== undefined) {
      currencies.push({ code, name, value });
    }
  }

  return currencies;
}

function dynamicRatesFrom(response) {
  const result = response.GetCursDynamicXMLResult;
  if (!result) {
    throw new Error('В SOAP-ответе ЦБ отсутствует результат динамики курса');
  }

  const rows = extractRows(result);
  const rates = [];

  for (const row of rows) {
    const rawDate = text(row.CursDate || row.Date);
    const value = number(row.Curs || row.Vcurs || row.Value);

    if (rawDate && value !== undefined) {
      const dateParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(rawDate);
      let date = rawDate;

      if (dateParts) {
        date = `${dateParts[3]}.${dateParts[2]}.${dateParts[1]}`;
      } else {
        const parsedDate = new Date(rawDate);
        if (!Number.isNaN(parsedDate.getTime())) {
          date = new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'UTC',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          }).format(parsedDate);
        }
      }

      rates.push({ date, value });
    }
  }

  return rates;
}

function parseDateRange(fromDateValue, toDateValue) {
  const fromDate = new Date(fromDateValue);
  const toDate = new Date(toDateValue);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error('Переданы некорректные даты');
  }
  if (fromDate > toDate) {
    throw new Error('Дата начала не может быть позже даты окончания');
  }

  return { fromDate, toDate };
}

function createService() {
  return {
    CbrProxy: {
      CbrProxySoap: {
        async getValutes(_args, callback) {
          try {
            const cbr = await soap.createClientAsync(CBR_WSDL);
            // Дату конкретную поставил так как в воскрес делал, не подсасывает данные из за выходных
            const targetDate = '2026-10-30';
            const [ratesResponse] = await cbr.GetCursOnDateXMLAsync({ On_date: targetDate });

            
            const valuteData = ratesResponse.GetCursOnDateXMLResult.ValuteData;
            const cursList = valuteData.ValuteCursOnDate;

            
            const result = cursList.map(c => ({
              code: String(c.Vcode || '').trim(),
              name: String(c.Vname || '').trim(),
              value: parseFloat(c.VunitRate || c.Vcurs)
            }));

            
            callback(null, 
              { getValutesResult: JSON.stringify(result, null, 2) }, 
              null, 
              null, 
              null, 
              null, 
              { targetNamespace: PROXY_NAMESPACE }
            );
          } catch (error) {
            callback(error);
          }
        },

        async getValute(args, callback) {
          try {
            const code = String(args.code || '').trim();
            if (!code) throw new Error('Параметр code обязателен');
            const { fromDate, toDate } = parseDateRange(
              args.fromDate,
              args.toDate
            );

            const cbr = await soap.createClientAsync(CBR_WSDL);
            const [response] = await cbr.GetCursDynamicXMLAsync({
              FromDate: fromDate.toISOString(),
              ToDate: toDate.toISOString(),
              ValutaCode: code
            });

            const result = dynamicRatesFrom(response);
            callback(null, 
              { getValuteResult: JSON.stringify(result) }, 
              null, 
              null, 
              null, 
              null, 
              { targetNamespace: PROXY_NAMESPACE }
            );
          } catch (error) {
            callback(error);
          }
        }
      }
    }
  };
}

function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wsdl = fs.readFileSync(
    path.join(__dirname, '..', 'proxy.wsdl.xml'),
    'utf8'
  );

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  soap.listen(server, '/soap', createService(), wsdl);

  server.listen(PORT, () => {
    console.log(`🚀 SOAP proxy server started: http://localhost:${PORT}/soap`);
    console.log(`📄 WSDL contract link: http://localhost:${PORT}/soap?wsdl`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { dynamicRatesFrom, parseDateRange, startServer };