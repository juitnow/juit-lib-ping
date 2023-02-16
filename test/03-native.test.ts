import { promisify } from 'node:util'

import * as native from '../native/ping.cjs'

const long = 'a_very_very_very_very_very_very_very_very_very_very_long_string'

describe('Native Adapter', () => {
  it('should not construct with the wrong number of parameters', () => {
    expect(() => (<any> native.open)())
        .toThrowError(TypeError, 'Expected 4 arguments: socket family, from address, source interface, callback')

    expect(() => (<any> native.open)(1))
        .toThrowError(TypeError, 'Expected 4 arguments: socket family, from address, source interface, callback')

    expect(() => (<any> native.open)(1, 2))
        .toThrowError(TypeError, 'Expected 4 arguments: socket family, from address, source interface, callback')

    expect(() => (<any> native.open)(1, 2, 3))
        .toThrowError(TypeError, 'Expected 4 arguments: socket family, from address, source interface, callback')
  })

  it('should not construct with the wrong family', () => {
    expect(() => (<any> native.open)('foo', 'addr', 'if', 'cb'))
        .toThrowError(TypeError, 'Specified socket family is not a number')

    expect(() => (<any> native.open)(12345, 'addr', 'if', 'cb'))
        .toThrowError(TypeError, 'Socket family must be AF_INET or AF_INET6')
  })

  it('should not construct with the wrong from address', () => {
    expect(() => (<any> native.open)(native.AF_INET, 123, 'if', 'cb'))
        .toThrowError(TypeError, 'From address must be a string, null or undefined')

    expect(() => (<any> native.open)(native.AF_INET, long, 'if', 'cb'))
        .toThrowError(TypeError, 'From address must be at most 40 characters long')

    expect(() => (<any> native.open)(native.AF_INET, '::1', 'if', 'cb'))
        .toThrowError(TypeError, 'Invalid IPv4 from address: ::1')

    expect(() => (<any> native.open)(native.AF_INET6, 123, 'if', 'cb'))
        .toThrowError(TypeError, 'From address must be a string, null or undefined')

    expect(() => (<any> native.open)(native.AF_INET6, '127.0.0.1', 'if', 'cb'))
        .toThrowError(TypeError, 'Invalid IPv6 from address: 127.0.0.1')

    expect(() => (<any> native.open)(native.AF_INET6, long, 'if', 'cb'))
        .toThrowError(TypeError, 'From address must be at most 40 characters long')
  })

  it('should not construct with the wrong source interface', () => {
    expect(() => (<any> native.open)(native.AF_INET, '127.0.0.1', 123, 'cb'))
        .toThrowError(TypeError, 'Source interface must be a string, null or undefined')

    expect(() => (<any> native.open)(native.AF_INET, '127.0.0.1', long, 'cb'))
        .toThrowError(TypeError, /^Source interface must be at most \d+ characters long$/)

    expect(() => (<any> native.open)(native.AF_INET6, '::1', 123, 'cb'))
        .toThrowError(TypeError, 'Source interface must be a string, null or undefined')

    expect(() => (<any> native.open)(native.AF_INET6, '::1', long, 'cb'))
        .toThrowError(TypeError, /^Source interface must be at most \d+ characters long$/)
  })

  it('should not construct with the wrong callback', () => {
    expect(() => (<any> native.open)(native.AF_INET, '127.0.0.1', 'eth0', 'callback'))
        .toThrowError(TypeError, 'Specified callback is not a function')

    expect(() => (<any> native.open)(native.AF_INET6, '::1', 'eth0', 'callback'))
        .toThrowError(TypeError, 'Specified callback is not a function')
  })

  it('should not construct with the wrong callback', () => {
    expect(() => (<any> native.open)(native.AF_INET, '127.0.0.1', 'eth0', 'callback'))
        .toThrowError(TypeError, 'Specified callback is not a function')

    expect(() => (<any> native.open)(native.AF_INET6, '::1', 'eth0', 'callback'))
        .toThrowError(TypeError, 'Specified callback is not a function')
  })

  it('should not bind to the wrong source interface', async () => {
    const open = promisify(native.open)

    await expectAsync(open(native.AF_INET, null, 'xyznope'))
        .toBeRejectedWith(jasmine.objectContaining({
          syscall: jasmine.stringMatching(/^(setsockopt)|(if_nametoindex)$/),
        }))

    await expectAsync(open(native.AF_INET6, null, 'xyznope'))
        .toBeRejectedWith(jasmine.objectContaining({
          syscall: jasmine.stringMatching(/^(setsockopt)|(if_nametoindex)$/),
        }))
  })


  it('should not bind to the wrong from address', async () => {
    // sorry, cloudflare 1.1.1.1

    const open = promisify(native.open)

    await expectAsync(open(native.AF_INET, '1.1.1.1', null))
        .toBeRejectedWith(jasmine.objectContaining({
          syscall: 'bind',
        }))

    await expectAsync(open(native.AF_INET6, '2606:4700:4700::1111', null))
        .toBeRejectedWith(jasmine.objectContaining({
          syscall: 'bind',
        }))
  })
})
