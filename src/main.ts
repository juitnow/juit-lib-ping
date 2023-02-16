#!/usr/bin/env node

/* coverage ignore file */
/* eslint-disable no-console */
import { isIP } from 'node:net'

import { createPinger } from './index'

import type { PingerOptions } from './index'

async function main(to: string, from: string = '', protocol?: 'ipv4' | 'ipv6'): Promise<void> {
  const options: PingerOptions = { protocol }

  if (isIP(from)) {
    options.from = from
  } else if (from) {
    options.source = from
  }

  const pinger = await createPinger(to, options)

  function stop(): void {
    const { sent, received, latency } = pinger.stats()
    const loss = Math.round((1 - (received / sent)) * 100)
    const average = Math.round(latency * 100) / 100

    console.log(`--- ${to} ping statistics ---`)
    console.log(`${sent} packets sent, ${received} received, ${loss}% packet loss, avgerage latency ${average}ms`)

    pinger.close().then(() => process.exit(0), (error) => {
      console.error('Error closing', error)
      process.exit(1)
    })
  }

  pinger.on('error', (error) => {
    console.error('Error pinging', error)
    stop()
  })

  pinger.on('warning', (code, message) => {
    console.log(`**WARNING** ${message} (code=${code})`)
  })

  pinger.on('pong', (latency) => {
    latency = Math.round(latency * 100) / 100
    console.log(`Response from ${pinger.target}: latency=${latency}ms`)
  })

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  if (pinger.from) {
    console.log(`PING ${to} (${pinger.target}) from address ${pinger.from}`)
  } else if (pinger.source) {
    console.log(`PING ${to} (${pinger.target}) from interface ${pinger.source}`)
  } else {
    console.log(`PING ${to} (${pinger.target})`)
  }

  pinger.start()
}

/* ========================================================================== */

let to: string | undefined = undefined
let from: string | undefined = undefined
let protocol: 'ipv4' | 'ipv6' | undefined = undefined

for (let i = 2; i < process.argv.length; i ++) {
  if (process.argv[i] === '-I') {
    from = process.argv[++i]
    continue
  }

  if (process.argv[i] === '-6') {
    protocol = 'ipv6'
    continue
  }

  if (process.argv[i] === '-4') {
    protocol = 'ipv4'
    continue
  }

  to = process.argv[i]
}

if (! to) {
  console.log('Usage: juit-ping [-4|-6|-I ...] target')
  process.exit(1)
}

main(to, from, protocol).catch((error) => {
  console.error('Error starting', error)
  process.exit(2)
})
