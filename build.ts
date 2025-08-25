import os from 'node:os'

import { banner, exec, hookBefore, log, plugjs, tasks } from '@plugjs/build'

const build = plugjs({
  ...tasks(),

  async _enable_ping(): Promise<void> {
    if (os.platform() === 'linux') {
      banner('Enabling ping for non-root users')
      const uid = process.getuid!()
      await exec('sudo', '-n', 'sysctl', '-w', `net.ipv4.ping_group_range=${uid} ${uid}`).catch((error) => log.error(error))
      await exec('sudo', '-n', 'sysctl', '-w', `net.ipv6.ping_group_range=${uid} ${uid}`).catch((error) => log.error(error))
    }
  },
})

hookBefore(build, 'test', [ '_enable_ping' ])
export default build
