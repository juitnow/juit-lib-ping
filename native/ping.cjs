'use strict'

const os = require('node:os')
const native = require(`./${os.platform()}-${os.arch()}/ping.node`)

module.exports = native
