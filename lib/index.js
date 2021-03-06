'use strict'
/*
 * See the NOTICE.txt file distributed with this work for additional information
 * regarding copyright ownership.
 * Sematext licenses logagent-js to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
var fs = require('fs')
var moment = require('moment')
var crypto = require('crypto')
var MultiLine = require('./multiLine.js')
var geoip = null
var LOG_SOURCE_FIELD_NAME = 'logSource'
var mergeConfig = require('./mergePatternFiles.js')
var consoleLogger = require('./logger.js')
function LogParser (fileName, options, readyCallback) {
  this.fileName = fileName
  this.ready = false
  this.LOG_SOURCE_FIELD_NAME = LOG_SOURCE_FIELD_NAME
  this.readyCallback = readyCallback
  this.options = options
  this.sources = {}
  this.sourceBlacklist = {}
  this.MAX_TRAINING_LINES = (Number(process.env.LOGAGENT_MAX_TRAINING_LINES) || 100)
  this.patternMatchingDisabled = (process.env.PATTERN_MATCHING_ENABLED === 'false')
  this.load(fileName || require('path').join(__dirname, '../patterns.yml'), options)
  this.initMaxmind()
  setInterval(function () {
    // clean caches once a minute
    this.sources = {}
    this.sourceBlacklist = {}
  }.bind(this), 5 * 60000)
}
function initGeoIp (err, fileName) {
  if (err) {
    this.cfg.geoIPEnabled = false
    if (this.readyCallback) {
      this.readyCallback(this)
      this.readyCallback = null
    }
    return
  }
  try {
    fs.statSync(fileName)
    geoip.init(fileName, {indexCache: true, checkForUpdates: true})
    this.cfg.geoIPEnabled = true
    if (this.cfg.globalTransform) {
      this.cfg.globalTransform = this.cfg.globalTransform.bind({
        moment: moment,
        geoip: geoip,
        enrichGeoIp: this.enrichGeoIp
      })
    }
  } catch (fsStatError) {
    this.cfg.geoIPEnabled = false
  }
  if (this.readyCallback) {
    this.readyCallback(this)
    this.readyCallback = null
  }
}
LogParser.prototype = {
  initMaxmind: function () {
    if (this.cfg.geoIP && (process.env.GEOIP_ENABLED === 'true' || process.env.GEOIP_ENABLED > 0)) {
      var fileName = (process.env.MAXMIND_DB_DIR || this.cfg.maxmindDbDir) + 'GeoIPCity.dat'
      var cbInitGeoIp = null
      try {
        try {
          fs.statsSync(fileName)
          geoip = require('maxmind')
          initGeoIp.bind(this)(null, fileName)
          cbInitGeoIp = null
        } catch (fsStatsErr) {
          cbInitGeoIp = initGeoIp.bind(this)
        }
        var maxmindUpdate = require('./maxmind-update')
        this.maxmindUpdate = maxmindUpdate(this.cfg.debug,
          (process.env.MAXMIND_DB_DIR || this.cfg.maxmindDbDir),
          cbInitGeoIp)
      } catch (err) {
        console.log(err.stack)
        if (this.readyCallback) {
          var self = this
          setTimeout(function () {
            self.readyCallback(self)
            self.readyCallback = null
          }, 0)
        }
      }
    } else {
      if (this.readyCallback)
        this.readyCallback(this)
      this.readyCallback = null
    }
  },
  hotReload: function (changedFile) {
    var filesToLoad = this.fileName || require('path').join(__dirname, '../patterns.yml')
    consoleLogger.log('hot reload pattern files: ' + changedFile + ' modified -> reload all ' + filesToLoad)
    this.load(filesToLoad, this.options)
  },
  load: function (names, options) {
    try {
      var defaultPatternFile = require('path').join(__dirname, '../patterns.yml')
      var filesToLoad = []
      if (names instanceof Array) {
        if (names.length == 0) {
          filesToLoad = [defaultPatternFile]
        } else {
          filesToLoad = [defaultPatternFile].concat(names)
        }
      }
      if (typeof names === 'string') {
        filesToLoad = [defaultPatternFile].concat([names])
      }
      this.cfg = mergeConfig(filesToLoad, this.hotReload.bind(this))
      if (this.cfg.autohash) {
        console.log('Hashing field content enabled for field names: ' + this.cfg.autohash)
      }
      this.patterns = this.cfg.patterns
      if (options && options.whitelist) {
        this.whitelist(options.whitelist)
      }
      if (options && options.blacklist) {
        this.blacklist(options.blacklist)
      }
    } catch (e) {
      console.log(e)
      this.patterns = []
      process.exit()
    } finally {
      return this.patterns
    }
  },
  whitelist: function (whitelist) {
    this.patterns = this.patterns.filter(function (e) {
      return (e.sourceName && e.sourceName.match(whitelist))
    })
  },
  blacklist: function (blacklist) {
    this.patterns = this.patterns.filter(function (e) {
      return !(e.sourceName && e.sourceName.match(blacklist))
    })
  },
  enrichGeoIp: function (parsedObject, fieldName) {
    if (!this.cfg.geoIPEnabled || !fieldName) {
      return null
    }
    if (parsedObject[fieldName]) {
      var location = geoip.getLocation(parsedObject[fieldName])
      if (location) {
        parsedObject['geoip'] = {location: [location.longitude, location.latitude], info: location}
      }
    }
  },
  getPatternsForSource: function (sourceName) {
    if (!sourceName) {
      return this.patterns // try all
    }
    var src = this.sources[sourceName]
    if (src && src.patterns) {
      return this.sources[sourceName].patterns
    }
    var exclude = []
    var include = this.patterns.filter(function (p) {
      if (sourceName && sourceName.match && sourceName.match(p.sourceName)) {
        return true
      } else {
        exclude.push(p)
      }
    })

    var patternLists = include.concat(exclude)
    // console.log('Patterns for source ' + sourceName + ' : ex:' + exclude.length + ' incl:' + include.length)
    if (!src) {
      this.sources[sourceName] = {}
    }
    this.sources[sourceName].patterns = patternLists
    return patternLists
  },
  getMultiLineReader: function (sourceName, parser) {
    if (!sourceName) {
      return this.getMultiLineReader('unknown', parser)
    }
    var src = this.sources[sourceName]
    if (src && src.reader) {
      return this.sources[sourceName].reader
    } else {
      this.sources[sourceName] = {}
      var include = this.patterns.filter(function (p) {
        if (sourceName && sourceName.match && sourceName.match(p.sourceName)) {
          return true
        }
      })
      if (include.length > 0) {
        this.sources[sourceName].reader = new MultiLine(include[0].blockStart, parser)
        return this.sources[sourceName].reader
      } else {
        this.sources[sourceName].reader = new MultiLine(/^\S+/, parser)
        return this.sources[sourceName].reader
      }
    }
  },
  hash: function hash (input) {
    var sha1 = crypto.createHash('sha1')
    sha1.update(input.toString())
    return sha1.digest('hex')
  },
  parseDate: function (strDate, dateFormat) {
    var d = null
    if (dateFormat && strDate) {
      d = moment(String(strDate).trim().replace('  ', ' '), dateFormat.trim(), true) || moment(strDate.trim().replace('  ', ' '), this.cfg.dateFormats, true)
    }
    if (d && d.isValid()) {
      return d.toDate()
    } else {
      // console.log('DATE not matched' + strDate + ' ' + dateFormat)
      return null
    }
  },
  matchPatterns: function (p, parsed, line) {
    var match = line.match(p.regex)
    if (match) {
      if (p.inputFilter !== undefined && p.inputFilter.test !== undefined) {
        try {

          if (!p.inputFilter.test(line)) {
            // calling function should drop this message
            parsed.logagentDropMessage = true
            return 1
          }
        } catch (ex) {
          console.log('Error in' + p.type + '.inputFilter.test():' + ex)
        }
      }
      if (p.inputDrop && p.inputDrop.test) {
        try {
          if (p.inputDrop.test(line)) {
            // calling function should drop this message
            parsed.logagentDropMessage = true
            return 1
          }
        } catch (ex) {
          console.log('Error in' + p.type + '.inputDrop.test():' + ex)
        }
      }
      parsed._type = p.type
      if (p.fields && (match.length > p.fields.length)) {
        for (var i = 0; i < p.fields.length; i++) {
          var value = match[i + 1]

          // convert to number
          if (!isNaN(value) && value !== '') {
            value = Number(value)
          }
          if (this.cfg.autohash && this.cfg.autohash.test(p.fields[i])) {
            value = this.hash(value)
          }
          if (!p.fieldDefinition) {
            p.fieldDefinition = {}
          }
          var fieldDefinition = p.fieldDefinition[i]
          if (!fieldDefinition) {
            fieldDefinition = p.fieldDefinition[i] = p.fields[i].split(':')
          }
          if (fieldDefinition[0] == p.geoIP) {
            this.enrichGeoIp(parsed, p.geoIP)
          }
          if (fieldDefinition[1] && (typeof value === 'string') && /number/.test(fieldDefinition[1])) {
            if (!isNaN(value) && value !== '') {
              value = Number(value)
            } else {
              value = 0
            }
          }
          if (fieldDefinition[1] && (typeof value === 'number') && /string/.test(fieldDefinition[1])) {
            value = String(value)
          }
          parsed[fieldDefinition[0]] = value
        }
        if (parsed['ts']) {
          var timestamp = this.parseDate(parsed['ts'], p.dateFormat)
          if (timestamp) {
            parsed['@timestamp'] = timestamp
          }
        }
        if (p.transform) {
          try {
            p.transform(parsed)
          } catch (ex) {
            console.log('Error in' + p.type + '.transform():' + ex)
          }
        }
        if (p.filter) {
          try {
            if (!p.filter(parsed, p)) {
              // calling function should drop this message
              parsed.logagentDropMessage = true
              return 1
            }
          } catch (ex) {
            console.log('Error in' + p.type + '.filter():' + ex)
          }
        }
        this.enrichGeoIp(p, p.geoIP)
        // remove ts field, because Elasticsearch
        // might have problems to index it
        // it could be recognized as string or data
        // depending on its content
        delete parsed.ts
        return 1
      }
    } else {
      return 0
    }
  },
  // optimize performance, by keeping last matched pattern
  // on top if the list,
  // assuming the next line will have the same format
  bubbleUp: function (plist, pos) {
    if (pos === 0) {
      return
    }
    // remove element on pos
    var tmp = plist[0]
    plist[0] = plist[pos]
    plist[pos] = tmp
  },
  parseLine: function (line, source, cbf) {
    var br = this.getMultiLineReader(source, function (data) {
      setImmediate(function () {
        try {
          this._parseLine(data, source, cbf)
        } catch (err) {
          // console.log('Error parsing logs from ' + source +  ': ' + err + ' originalLine: ' + line)
          cbf(err, data)
        }
      }.bind(this))
    }.bind(this))
    br.add(line)
  },
  globalTransform: function (source, parsed) {
    if (this.cfg.globalTransform) {
      try {
        this.cfg.globalTransform(source, parsed)
      } catch (ex) {
        console.error('Error in gloabalTransform():' + ex)
      }
    }
  },
  _parseLine: function (line, source, cbf) {
    if (line === null || line === '') {
      cbf('empty', null)
    }
    var parsed = {}
    if (this.cfg.originalLine === true && (!this.patternMatchingDisabled)) {
      parsed.originalLine = line
    }
    parsed[LOG_SOURCE_FIELD_NAME] = source
    // JSON handling
    var trimedLine = line.trim()
    if (/^\[{0,1}\{.*\}\]{0,1}$/.test(trimedLine)) {
      try {
        parsed = JSON.parse(trimedLine)
        if (!(parsed['@timestamp'])) {
          if (parsed.time && parsed.time instanceof Date) {
            parsed['@timestamp'] = parsed.time
          } else if (parsed.t && parsed.t instanceof Date) {
            parsed['@timestamp'] = parsed.t
          } else if (parsed.timestamp && parsed.task_uuid) {
            // python eliot logs
            parsed['@timestamp'] = new Date(parsed.timestamp * 1000)
          } else {
            parsed['@timestamp'] = new Date()
          }
        }
        if (!parsed.message && parsed.msg) {
          parsed.message = parsed.msg
        }
        // TODO JSON GeoIP enrichment
        this.globalTransform(source, parsed)
        return cbf(null, parsed)
      } catch (ex) {
        // ignore treat as text
      }
    }
    if (this.patternMatchingDisabled || this.sourceBlacklist[source] >= this.MAX_TRAINING_LINES) {
      this.sourceBlacklist[source] = this.MAX_TRAINING_LINES
      var rv = {'@timestamp': new Date(), message: line}
      rv[LOG_SOURCE_FIELD_NAME] = source
      if (this.globalTransform) {
        this.globalTransform(source, rv)
      }
      return cbf('not found', rv)
    }
    var patternList = this.getPatternsForSource(source) || this.patterns
    for (var k in patternList) {
      var patterns = patternList[k]
      for (var i = 0; i < patterns.match.length; i++) {
        if (this.matchPatterns(patterns.match[i], parsed, line)) {
          this.bubbleUp(patternList, k)
          if (parsed.logagentDropMessage) {
            return cbf(null, null)
          }
          // this.sources[source].patterns = [patternList[k]]
          if (!parsed._type) {
            parsed._type = patternList[k].type
          }
          if (this.globalTransform) {
            this.globalTransform(source, parsed)
          }
          this.sourceBlacklist[source] = 0
          return cbf(null, parsed)
        }
      }
    }
    this.sourceBlacklist[source] = (this.sourceBlacklist[source] || 0) + 1
    var rv2 = {'@timestamp': new Date(), message: line}
    rv2[LOG_SOURCE_FIELD_NAME] = source
    if (this.globalTransform) {
      this.globalTransform(source, rv2)
    }
    return cbf('not found', rv2)
  }
}

module.exports = LogParser
