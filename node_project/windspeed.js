const url = 'https://rucsoundings.noaa.gov/get_soundings.cgi?data_source=Op40&latest=latest&n_hrs=18&fcst_len=shortest&airport=KLNS&text=Ascii%20text%20%28GSL%20format%29&hydrometeors=false&start=latest'

let logger

async function initialize(_logger){
    logger = _logger
}

async function getAndParseData(){
    try {
        const response = await fetch(url)
        if (!response.ok){
            throw new Error("Whoops")
        }
        const data = await response.text()
        return await parse(data)
    } catch (error) {
        console.log(error)
        return null
    }
}

async function parse(data){
    const layerSize = 100
    const maxAltitude = 2000
    const split = data.split('\n')
    let table = []
    let newSet = true
    let surface
    let group
    let nextLayer = 0
    let previousLayer = 0
    let day
    let month
    let year
    let hour
    for (let i = 0; i < split.length; i++){
        let line = split[i].trim().split(/ +/)
        let first = line[0]
        if (first === '' || isNaN(first)){
            if (first === 'Op40'&& !isNaN(line[1])){
                hour = line[1]
                day = line[2]
                month = line[3]
                year = line[4]
            }
            if (!newSet){
                newSet = true
                table.push(group)
            }
        } else {
            if (first <= 3){
                continue
            }
            if (line[2] === '99999'){
                continue // Random junk lines that have to be thrown out for some reason.
            }
            if (first === '9'){
                newSet = false
                nextLayer = 0
                previousLayer = 0
                surface = line[2]
                group = {
                    hour: hour,
                    day: day,
                    month: month,
                    year: year,
                    layerData: []
                }
            }
            let altitude = line[2] - surface
            if (previousLayer <= maxAltitude && altitude >= nextLayer) {
                group.layerData.push(await createLayerData(line, altitude))
                previousLayer = altitude
                nextLayer = altitude + layerSize
            }
        }
    }
    return table
}

async function createLayerData(line, altitude){
    return {
        altitude: altitude,
        windSpeed: Math.round(line[6] * 1.151),
        windDirection: Number(line[5]),
        temperature: Math.round(((line[3] / 10) * 1.8) + 32)
    }
}

async function sunrise(time){
    const table = await getAndParseData()
    const sunrise = new Date(time).getHours()
    const start = sunrise - 1
    const end  = sunrise + 3
    let returnData = []
    for (let i = 0; i < table.length; i++){
        const hour = table[i].hour
        if (hour >= start && hour <= end){
            returnData.push(table[i])
        }
    }
    return returnData
}

async function sunset(time){
    const table = await getAndParseData()
    const sunset = new Date(time)
    const sunsetHour = sunset.getUTCHours()
    const start = sunsetHour - 3
    const end  = sunsetHour + 1
    let returnData = []
    for (let i = 0; i < table.length; i++){
        const hour = table[i].hour
        if (hour >= start && hour <= end){
            returnData.push(table[i])
        }
    }
    return returnData
}

module.exports = { initialize, sunrise, sunset }