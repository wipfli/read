const express = require('express')
const moment = require('moment')
const Influx = require('influx')
const cors = require('cors')

const influx = new Influx.InfluxDB({
    database: 'ballometer',
    host: 'localhost'
})

const app = express()
app.use(express.json())
app.use(cors())

app.listen(process.env.PORT, () => {
    console.log('Read service running on port ' + String(process.env.PORT))
})

const isAlphabetic = text => /^[a-zA-Z]+$/.test(text)
const isNumeric = text => /^[0-9]+$/.test(text)

const getLatestValue = async (username, field) => {
    // example result:
    // {
    //     field: 'sht_temperature',
    //     value: 306.0,
    //     time: 1608369595.4
    // }
    const query = `SELECT ${field} FROM ballometer WHERE username = \'${username}\' ORDER BY DESC LIMIT 1`
    const result = await influx.query(query)
    /*{
    time: 2020-12-19T09:19:55.000Z {
      _nanoISO: '2020-12-19T09:19:55Z',
      getNanoTime: [Function: getNanoTimeFromISO],
      toNanoISOString: [Function: toNanoISOStringFromISO]
    },
    sht_temperature: 306
    }*/
    if (!result[0]) {
        return { field: null, value: null, time: null }
    }
    return { 
        field: field, 
        value: result[0][field], 
        time: result[0].time.getNanoTime() * 1e-9
    }
}

const getNow = async (username) => {
    /* 
    Returns the lastest values of a subset of fields.
    The timestamp indicates the time of the newest field.
    Example
    {  
        'altitude': 1464.343,
        'speed': 8.6,
        'heading': 234, 
        'climb': null,
        'longitude': 8.43490,
        'latitude': 43.4309,
        'time': 1608397940.45,
    } 
    */
    const now = {}
    const mappings = [
        { ui: 'altitude', influx: 'vario_altitude' },
        { ui: 'speed', influx: 'gps_speed' },
        { ui: 'heading', influx: 'gps_heading' },
        { ui: 'climb', influx: 'vario_speed' },
        { ui: 'longitude', influx: 'gps_longitude' },
        { ui: 'latitude', influx: 'gps_latitude' },
    ]
    const latestValues = await Promise.all(mappings.map(mapping => {
        return getLatestValue(username, mapping.influx)
    }))
    mappings.map((mapping, i) => now[mapping.ui] = latestValues[i].value)
    now.time = Math.max(...latestValues.map(l => l.time))
    return now
}

app.get('/now', (req, res) => {
    if (!req.query.username || !isAlphabetic(req.query.username)) {
        return res.sendStatus(400)
    }
    getNow(req.query.username)
        .then(now => res.send(now))        
        .catch(err => {
            console.log(err)
            res.sendStatus(500)
        })
})

const getPoints = async (username, flightId) => {

    const myFlightId = flightId ? flightId : Math.max(...await getFlightIds(username))

    const start = await getStart(username, myFlightId)
    const stop = await getStop(username, myFlightId)

    // Query at most 3600 points. If recording is shorter than
    // 1 hour, the intervall is 1000 ms, else it gets longer.
    // Examples: 
    // 5 minutes recording -> 1000 ms interval
    // 1 hour recording -> 1000 ms interval
    // 2 hours recording -> 2000 ms interval
    const interval_ms = Math.max(1000, Math.floor((stop - start) / 3600 / 1e-3))

    const mappings = [
        { ui: 'altitude', influx: 'vario_altitude' },
        { ui: 'speed', influx: 'gps_speed' },
        { ui: 'heading', influx: 'gps_heading' },
        { ui: 'climb', influx: 'vario_speed' },
        { ui: 'longitude', influx: 'gps_longitude' },
        { ui: 'latitude', influx: 'gps_latitude' },
    ]

    const parts = mappings.map(mapping => `mean(${mapping.influx}) as ${mapping.ui},`)

    const query = `SELECT ${parts.join(' ').slice(0, -1)} FROM ballometer WHERE flight_id = \'${myFlightId}\' AND username = \'${username}\' AND time >= \'${moment(start / 1e-3).toISOString()}\' AND time <= \'${moment(stop / 1e-3).toISOString()}\' GROUP BY time(${interval_ms}ms) fill(linear)`

    const results = await influx.query(query)

    const points = results.map(r => {
        const point = r
        point.time = r.time.getNanoTime() * 1e-9
        return point
    })
    // points looks like
    // [{
    //     time: 1608369598,
    //     altitude: 6000,
    //     speed: 100,
    //     heading: null,
    //     climb: null,
    //     longitude: null,
    //     latitude: null
    // }, ...]

    return {
        time: points.map(point => point.time),
        altitude: points.map(point => point.altitude),
        speed: points.map(point => point.speed),
        heading: points.map(point => point.heading),
        climb: points.map(point => point.climb),
        longitude: points.map(point => point.longitude),
        latitude: points.map(point => point.latitude)
    }
}

app.get('/points', (req, res) => {
    // Returns all the measurements that were stored using linear 
    // interpolation. Interval ist 1000 ms up to one hour recording
    // and increases then to keep maximal number of points at 3600.
    // If flighId is undefined, returns data for the latest flight.
    // {
    //     'altitude': [918.8838187009885, 919.222839137572, ...], 
    //     'speed': [12.3, 13.4, ...],
    //     'climb': [0.5880960494320139, 0.5206506714967045, ...], 
    //     'longitude': [8.43490, 8.43491, ...], 
    //     'latitude': [43.64543, 43.645431, ...], 
    //     'time': [1608369593.0, 1608369594.0, ...]
    // }
    if (!req.query.username || !isAlphabetic(req.query.username)){
        return res.sendStatus(400)
    }
    if (req.query.flightId && !isNumeric(req.query.flightId)) {
        return res.sendStatus(400)
    }
    getPoints(req.query.username, req.query.flightId)
        .then(points => res.send(points))
        .catch(err => {
            console.log(err)
            res.sendStatus(500)
        })
})

const getStart = async (username, flightId) => {
    const query = `SELECT * FROM ballometer WHERE flight_id = \'${flightId}\' AND username = \'${username}\' LIMIT 1`
    const result = await influx.query(query)
    if (!result[0]) {
        return 0.0
    }
    return result[0].time.getNanoTime() * 1e-9
}

const getStop = async (username, flightId) => {
    const query = `SELECT * FROM ballometer WHERE flight_id = \'${flightId}\' AND username = \'${username}\' ORDER BY DESC LIMIT 1`
    const result = await influx.query(query)
    if (!result[0]) {
        return 0.0
    }
    return result[0].time.getNanoTime() * 1e-9
}

const getFlightIds = async (username) => {
    const query = `SHOW TAG VALUES WITH KEY = "flight_id" WHERE username = \'${username}\'`
    const result = await influx.query(query)
    return result.map(r => r.value)
}

const getListFlights = async (username) => {
    const flightIds = await getFlightIds(username)
    const starts = await Promise.all(flightIds.map(flightId => getStart(username, flightId)))
    return flightIds.map((flightId, i) => ({
        flight_id: flightId,
        start: starts[i]
    }))
}

app.get('/listFlights', (req, res) => {
    // returns a list of flights in the form
    // [
    //     {
    //         'flight_id': 1,
    //         'start': 1608369593.0
    //     }, 
    //     ...
    // ]
    if (!req.query.username || !isAlphabetic(req.query.username)) {
        return res.sendStatus(400)
    }

    getListFlights(req.query.username)
        .then(listFlights => res.send(listFlights))
        .catch(err => {
            console.log(err)
            res.sendStatus(500)
        })
})

const getListUsernames = async () => {
    const query = 'SHOW TAG VALUES WITH KEY = "username"'
    const result = await influx.query(query)
    return result.map(r => r.value)
}

app.get('/listUsernames', (req, res) => {
    getListUsernames()
        .then(listUsernames => res.send(listUsernames))
        .catch(err => {
            console.log(err)
            res.sendStatus(500)
        })
})
