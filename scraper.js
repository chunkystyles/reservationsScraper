import puppeteer from 'puppeteer';
import {Webhook, EmbedBuilder} from '@tycrek/discord-hookr';
import * as mqttService from './mqttService.js';
import {TOTP} from 'totp-generator';

let config;
let secrets;
let logger;

const embedColors = [
  '#97A88E',
  '#B2222A',
  '#EF9D7F',
  '#027978',
  '#F9DBA5',
  '#6E2250',
  '#332823'
];
let embedIndex = 0;

async function initialize(_config, _secrets, _logger) {
  config = _config;
  secrets = _secrets;
  logger = _logger;
}

async function runScraper(runConfig) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      // '--single-process', // I don't know why, but after upgrading to puppeteer 19, this is causing the browser to crash
      '--window-size=1920,1080' // default is 800x600
    ],
    defaultViewport: {
      width: 1920,
      height: 1080
    }
  });
  try {
    await doRun(browser, runConfig);
  } catch (e) {
    throw e;
  } finally {
    await browser.close();
  }
}

async function doRun(browser, runConfig) {
  let page;
  try {
    page = await login(browser);
  } catch (e) {
    throw e;
  }
  try {
    if (runConfig?.doBlackouts) {
      await doBlackouts(page, runConfig);
    }
  } catch (e) {
    logger.error(e);
  }
  try {
    if (runConfig?.doScrapeGuestData) {
      await scrapeGuestData(page, runConfig);
    }
  } catch (e) {
    logger.error(e);
  }
}

async function doBlackouts(page, runConfig) {
  logger.info('Running Blackouts');
  const rooms = secrets.blackouts.roomNames;
  await page.goto(secrets.blackouts.url);
  await page.waitForSelector('[class="blackout-room-id-date"]');
  const date = getScrapeDate(runConfig);
  let doCheck = true;
  const isDayBefore = date.getHours() >= 12;
  if (isDayBefore) {
    date.setDate(date.getDate() + 1);
  }
  const combos = new Map();
  for (let [comboName, containedNames] of Object.entries(secrets.blackouts.roomComboNames)) {
    combos.set(comboName, new Set(containedNames));
  }
  for (let i = 0; i <= 1; i++) {
    const roomSet = new Set(rooms);
    const dateString = getDateString(date);
    // Check for combo rooms that are occupied and remove the individual rooms from the set because the
    // blackout page will error if you try to blackout a room that is part of a combo that is already occupied
    for (const [comboName, containedNames] of combos) {
      const roomSelector = await page.$(`[class="room"][data-room-name="${comboName}"]`);
      if (!roomSelector) {
        continue;
      }
      const blackoutSelector = await roomSelector.$(`[class="blackout-room-id-date"][data-date="${dateString}"]`);
      if (!blackoutSelector) {
        for (const room of roomSet) {
          if (containedNames.has(room)) {
            // Remove the room from the potential blackout targets for this day
            roomSet.delete(room);
            logger.info(`Removing room name: ${room} because ${comboName} is occupied`);
          }
        }
      }
    }
    for (const room of roomSet) {
      const roomSelector = await page.$(`[class="room"][data-room-name="${room}"]`);
      if (!roomSelector) {
        continue;
      }
      const blackoutSelector = await roomSelector.$(`[class="blackout-room-id-date"][data-date="${dateString}"]`);
      if (blackoutSelector) {
        let isChecked = await isElementChecked(page, blackoutSelector);
        if (isChecked && !doCheck) {
          await blackoutSelector.click();
        } else if (!isChecked && doCheck) {
          await blackoutSelector.click();
        }
      }
    }
    date.setDate(date.getDate() - 2);
    doCheck = false;
  }
  const saveButton = await page.$('button[class="save"]');
  await Promise.all([
    page.waitForNavigation({waitUntil: 'networkidle0'}),
    saveButton.click()
  ]);
  await page.waitForSelector('#app > div > div.application-header > div.component.navigation > ul.navigation-links > li:nth-child(1) > a');
}

function getDateString(date) {
  const year = date.toLocaleString('default', {year: 'numeric'});
  const day = date.toLocaleString('default', {day: '2-digit'});
  const month = date.toLocaleString('default', {month: '2-digit'});
  return `${year}-${month}-${day}`;
}

async function login(browser) {
  const frontDeskLinkSelector = '#app > div > div.application-header > div.component.navigation > ul.navigation-links > li:nth-child(1) > a';
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
  await page.goto(secrets.loginUrl);
  try {
    await page.waitForSelector('button[type=submit]');
  } catch (e) {
    throw 'Selector for login button failed';
  }
  await page.type('#username', secrets.username);
  await page.type('#password', secrets.password);
  await page.screenshot({path: 'screenshots/login.png'});
  const button = await page.$('button[type=submit]');
  try {
    await Promise.all([
      page.waitForNavigation({waitUntil: 'networkidle0'}),
      button.click()
    ]);
    await page.waitForSelector(`#code, ${frontDeskLinkSelector}`);
  } catch (e) {
    throw 'Selector for OTP or Front Desk link on Calendar page failed';
  }
  const codeInput = await page.$('#code');
  if (codeInput) {
    const { otp, expires } = TOTP.generate(secrets.totp.secret);
    logger.info(`OTP was required, generated code ${otp} which expires at ${expires}`);
    await page.type('#code', otp);
    const rememberBrowser = await page.$('#rememberBrowser');
    if (!await isElementChecked(page, rememberBrowser)) {
      await rememberBrowser.click();
    }
    await page.screenshot({path: 'screenshots/otp.png'});
    const button2 = await page.$('button[type=submit]');
    try {
      await Promise.all([
        page.waitForNavigation({waitUntil: 'networkidle0'}),
        button2.click()
      ]);
      await page.waitForSelector(frontDeskLinkSelector);
    } catch (e) {
      throw 'Selector for Front Desk link on Calendar page failed after OTP entered';
    }
  }
  await page.screenshot({path: 'screenshots/calendar.png'});
  return page;
}

async function scrapeGuestData(page, runConfig) {
  const maps = [];
  try {
    await Promise.all([
      page.waitForNavigation({waitUntil: 'networkidle0'}),
      page.click('#app > div > div.application-header > div.component.navigation > ul.navigation-links > li:nth-child(1) > a')
    ]);
    await page.waitForSelector('#app > div > div.application-body > div > table > tbody:nth-child(1) > tr:nth-child(1) > th > h2');
  } catch (e) {
    throw 'Selector for Arrivals header on Front Desk page first iteration failed';
  }
  let date = getScrapeDate(runConfig);
  // If the scraper is run the day before, we need to check the next day's arrivals instead of today's
  const isDayBefore = date.getHours() >= 12;
  for (let i = 0; i < config.daysToCheck; i++) {
    if (i > 0 || isDayBefore) {
      date.setDate(date.getDate() + 1);
      const month = date.toLocaleString('en-US', {month: 'short'});
      const dateString = `${month} ${date.getDate()}, ${date.getFullYear()}`;
      const dateInput = await page.$('#date_input_input');
      await dateInput.click({clickCount: 3}); // click 3 times to select all text
      await dateInput.type(dateString); // to then overwrite that text
      try {
        await Promise.all([
          page.waitForNavigation({waitUntil: ['networkidle0','domcontentloaded']}),
          page.click('#app > div > div.application-body > div > div.component.front-desk-form > form > div.component.tr-button.presentation-standard.precedence-primary > button > div > div')
        ]);
        await page.waitForSelector('#app > div > div.application-body > div > table > tbody:nth-child(1) > tr:nth-child(1) > th > h2');
      } catch (e) {
        throw 'Selector for Arrivals header on Front Desk page second iteration failed';
      }
    }
    await page.screenshot({path: `screenshots/frontDesk${i}.png`});
    maps.push(await getMapForDay(page));
  }
  for (let i = 0; i < config.daysToCheck; i++) {
    for (const entry of maps[i].get('checkins')) {
      const phonesAndPreviousStays = await getPhonesAndPreviousStaysFromLink(page, entry.link);
      if (i === 0) {
        entry.phones = phonesAndPreviousStays.phones;
      }
      entry.previousStays = phonesAndPreviousStays.previousStays;
    }
  }
  for (const entry of maps[0].get('stayovers')) {
    entry.phones = await getPhonesFromLink(page, entry.link);
  }
  const areEveningGuests = maps[0].get('checkins').length > 0 || maps[0].get('stayovers').length > 0;
  const areBreakfastGuests = maps[0].get('stayovers').length > 0 || maps[0].get('checkouts').length > 0;
  const occupancyMap = new Map();
  for (const roomName of secrets.roomNames) {
    occupancyMap.set(roomName,
        {
          occupiedTonight: false,
          checkingInToday: false
        });
  }
  for (const entry of maps[0].get('checkins')) {
    const rooms = []
    if (entry.room.includes('-')) {
      const split = entry.room.split('-');
      for (const val of split) {
        rooms.push(val);
      }
    } else if (entry.room.toLowerCase().includes('whole')) {
      for (const val of secrets.roomNames) {
        rooms.push(val);
      }
    } else {
      rooms.push(entry.room);
    }
    for (const room of rooms) {
      occupancyMap.get(room).occupiedTonight = true;
      occupancyMap.get(room).checkingInToday = true;
    }
  }
  for (const entry of maps[0].get('stayovers')) {
    const rooms = [];
    if (entry.room.includes('-')) {
      const split = entry.room.split('-');
      for (const val of split) {
        rooms.push(val);
      }
    } else if (entry.room.toLowerCase().includes('whole')) {
      for (const val of secrets.roomNames) {
        rooms.push(val);
      }
    } else {
      rooms.push(entry.room);
    }
    for (const room of rooms) {
      occupancyMap.get(room).occupiedTonight = true;
      occupancyMap.get(room).checkingInToday = false;
    }
  }
  const phoneNumberMap = combineAllPhoneNumbers(maps[0], secrets);
  mqttService.changeDeviceState('evening guests', areEveningGuests).then();
  mqttService.changeDeviceState('breakfast guests', areBreakfastGuests).then();
  for (const key of occupancyMap.keys()) {
    mqttService.publishAttributes('occupancy ' + key, occupancyMap.get(key)).then();
  }
  mqttService.publishAttributes('occupancy phone numbers',
      Object.fromEntries(phoneNumberMap)).then();
  const messages = createMessages(getScrapeDate(runConfig), maps, config.daysToCheck);
  for (const message of messages) {
    const webhook = new Webhook(secrets.scraper.webhook);
    webhook.setContent(message.content);
    webhook.addEmbed(message.embeds);
    await webhook.send();
  }
}

function getNextEmbedColor() {
  if (embedIndex >= embedColors.length) {
    embedIndex = 0;
  }
  return embedColors[embedIndex++];
}

async function getPhonesAndPreviousStaysFromLink(page, link) {
  return {
    phones: await getPhonesFromLink(page, link),
    previousStays: await getPreviousStays(page)
  }
}

async function getPhonesFromLink(page, link) {
  await page.goto(link);
  try {
    await page.waitForSelector('#app > div > div.application-body > div > div.reservation-page-body > div > div > div.reservation-details-column.customer > div.component.assign-customer > div.customer-body');
  } catch (e) {
    logger.error('Selector for Phone Numbers failed');
    return ['ERROR'];
  }
  const phoneElements = Array.from(await page.$$('.customer-phone > .component > a'));
  const phones = new Set();
  for (const phone of phoneElements) {
    phones.add(cleanPhone(await getInnerHtml(page, phone)));
  }
  return Array.from(phones);
}

async function getPreviousStays(page) {
  const date = new Date();
  try {
    await Promise.all([
      page.waitForNavigation({waitUntil: 'domcontentloaded'}),
      page.click('#app > div > div.application-body > div > div.reservation-page-body > div > div > div.reservation-details-column.customer > div.component.assign-customer > div.customer-header > div.customer-area > div.component.customer-name.small.has-link > a')
    ]);
    await page.waitForSelector('#app > div > div.application-body > div > div.customer-details-page-body > div > div > table > tbody');
  } catch (e) {
      logger.error('Wait for selector failed on previous stays table');
      return 'ERROR';
  }
  const table = await page.$('#app > div > div.application-body > div > div.customer-details-page-body > div > div > table > tbody');
  if (table === null) {
    logger.error('Table null for previous stays');
    return 'ERROR';
  }
  const rows = await table.$$('tr');
  const stays = [];
  for (const row of rows) {
    const totalString = await getInnerHtml(page, await row.$('td:nth-child(9) > a > div'));
    if (totalString && totalString === '$0.00') {
      // Not a real stay, don't count it.
      continue;
    }
    const roomNameElements = await row.$$('td:nth-child(4) > a.visible > div');
    const roomNames = [];
    for (const room of roomNameElements) {
      roomNames.push(cleanRoom(await getInnerHtml(page, room)));
    }
    const roomName = roomNames.join(', ');
    const arrivalString = await getInnerHtml(page, await row.$('td:nth-child(5) > a > div'));
    const departureString = await getInnerHtml(page, await row.$('td:nth-child(6) > a > div'));
    const timestamp = Date.parse(departureString);
    if (!isNaN(timestamp)) {
      const stayDate = new Date(timestamp);
      if (stayDate < date) {
        stays.push([new Date(timestamp), arrivalString, departureString, roomName]);
      }
    }
  }
  const lastStay = stays?.sort(function(left, right) {
    if (left[0] > right[0]) {
      return -1;
    } else if (left[0] < right[0]) {
      return 1;
    } else {
      return 0;
    }
  })[0];
  if (stays.length > 0) {
    return `${stays.length} previous stays, last on ${lastStay[1]}-${lastStay[2]} in ${lastStay[3]}`
  } else {
    return 'First time guest';
  }
}

async function getMapForDay(page) {
  let map = new Map();
  map.set('checkins', []);
  map.set('checkouts', []);
  map.set('stayovers', []);
  for (let type = 1; type < 4; type++) {
    let row = 3
    while (true) {
      const rowElement = await page.$(`#app > div > div.application-body > div > table > tbody:nth-child(${type}) > tr:nth-child(${row})`);
      if (rowElement === undefined || rowElement === null) {
        // Reached the end of the available rows
        break;
      }
      const name = await rowElement.$(`td:nth-child(2)`);
      const link = await rowElement.$(`td.booking-confirmation-id > a`);
      const room = await rowElement.$(`td:nth-child(4)`);
      const nights = await rowElement.$(`td:nth-child(5)`);
      const paid = await rowElement.$(`td:nth-child(6)`);
      const notes = Array.from(await rowElement.$$(`td:nth-child(7) > div > div`));
      row++;
      const entry = {
        name: cleanName(await getInnerHtml(page, name)),
        room: cleanRoom(await getInnerHtml(page, room)),
        nights: cleanNights(await getInnerHtml(page, nights)),
        amount: cleanPaid(await getInnerHtml(page, paid)),
        link: await getLink(page, link),
        notes: await cleanNotes(page, notes)
      }
      if (type === 1) {
        map.get('checkins').push(entry);
      } else if (type === 2) {
        map.get('checkouts').push(entry);
      } else {
        map.get('stayovers').push(entry);
      }
    }
  }
  return map;
}

function createMessages(today, maps, numberOfDays) {
  const isDayBefore = today.getHours() >= 12;
  if (isDayBefore) {
    today.setDate(today.getDate() + 1);
  }
  let messages = [];
  for (let i = 0; i < numberOfDays; i++) {
    let date = new Date(today);
    date.setDate(date.getDate() + i);
    messages.push(getMessageForDay(date, maps[i]));
  }
  return messages;
}

function getMessageForDay(day, map) {
  const checkins = map.get('checkins');
  const checkouts = map.get('checkouts');
  const message = {
    content: `__**${day.toLocaleString("en", {weekday: "long"})}**__`,
    embeds: []
  }
  if (checkins.length === 0) {
    const embed = new EmbedBuilder()
        .setDescription(':inbox_tray: :x:')
        .setColor(getNextEmbedColor());
    message.embeds.push(embed);
  } else {
    for (const entry of checkins) {
      const embed = new EmbedBuilder()
          .setDescription(`:inbox_tray: ${entry.name} :inbox_tray:`)
          .setFooter({text: entry.previousStays})
          .addField({name: 'Room', value: entry.room, inline: true})
          .addField({name: 'Nights', value: entry.nights, inline: true})
          .setColor(getNextEmbedColor());
      if (entry.guest) {
        embed.addField({name: 'Additional Guest Names', value: entry.guest, inline: false});
      }
      if (entry.notes) {
        for (const note of entry.notes) {
          embed.addField({name: note.name, value: note.value, inline: false});
        }
      }
      if (entry.phones) {
        let phones = '';
        for (let i = 0; i < entry.phones.length; i++) {
          if (i > 0) {
            phones += ', ';
          }
          phones += entry.phones[i];
        }
        embed.addField({name: 'Phone', value: phones, inline: false});
      }
      message.embeds.push(embed);
    }
  }
  if (checkouts.length === 0) {
    const embed = new EmbedBuilder()
        .setDescription(':outbox_tray: :x:')
        .setColor(getNextEmbedColor());
    message.embeds.push(embed);
  } else {
    for (const entry of checkouts) {
      const embed = new EmbedBuilder()
          .setDescription(`:outbox_tray: ${entry.name} :outbox_tray:`)
          .addField({name: 'Room', value: entry.room, inline: true})
          .addField({name: 'Due', value: entry.amount, inline: true})
          .setColor(getNextEmbedColor());
      message.embeds.push(embed);
    }
  }
  return message;
}

function combineAllPhoneNumbers(map, secrets) {
  const phoneNumberMap = new Map();
  const entries = [];
  for (const entry of map.get('checkins')) {
    entries.push(entry);
  }
  for (const entry of map.get('stayovers')) {
    entries.push(entry);
  }
  for (const entry of entries) {
    phoneNumberMap.set(secrets.roomNumberMap[entry.room], entry.phones);
  }
  return phoneNumberMap;
}

function cleanPhone(phone) {
  return phone.replace(/\D/g, '');
}

function cleanName(name) {
  const nameSansHtml = name.replaceAll(/<[^>]*>/g, ``);
  const split = nameSansHtml.split(', ');
  return `${split[1]} ${split[0]}`;
}

function cleanRoom(room) {
  const split = room.split(' ');
  return split[0];
}

function cleanNights(nights) {
  const split = nights.split(' ');
  return split[2];
}

function cleanPaid(paid) {
  if (paid.includes('Yes')) {
    return '$0.00';
  } else {
    const split = paid.split(' ');
    return split[2];
  }
}

async function cleanNotes(page, notes) {
  const cleanedNotes = [];
  for (const note of notes) {
    const innerHtml = await getInnerHtml(page, note);
    const split = innerHtml.split('</strong>');
    cleanedNotes.push({
      name: split[0].replace('<strong>', ''),
      value: split[1]
    });
  }
  return cleanedNotes;
}

async function getInnerHtml(page, element) {
  if (element === null) {
    return '';
  }
  return await page.evaluate(element => element.innerHTML, element);
}

async function isElementChecked(page, element) {
  if (element) {
    return await page.evaluate(element => element.checked, element);
  } else {
    return false;
  }
}

async function getLink(page, element) {
  if (element === null) {
    return '';
  }
  return await page.evaluate(element => element.href, element);
}

function getScrapeDate(runConfig) {
  const date = new Date();
  if (runConfig?.dateAdjust) {
    logger.info(`Adjusting date:${date} by:${runConfig.dateAdjust}`);
    date.setDate(date.getDate() + Number(runConfig.dateAdjust));
    logger.info('New date is ' + date);
  }
  return date;
}

function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

export {initialize, runScraper}
