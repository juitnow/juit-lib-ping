import { ProtocolHandler, rfc1071crc } from '../src/protocol'

describe('ICMPv4 protocol', () => {
  const handler4 = new ProtocolHandler(false)
  const packet4 = (<any> handler4)._packet
  const seqIn4 = (): number => (<any> handler4)._seq_in
  const seqOut4 = (): number => (<any> handler4)._seq_out

  const reply4 = (): Buffer => {
    const buffer = Buffer.from(handler4.outgoing())
    buffer.writeUInt8(0x00, 0) // type
    buffer.writeUInt16BE(0x00, 2) // checksum
    buffer.writeUInt16BE(seqOut4(), 6) // sequence
    buffer.writeUInt32BE(seqOut4(), 16) // sequence full
    buffer.writeUInt16BE(rfc1071crc(buffer), 2)
    return buffer
  }

  const handler6 = new ProtocolHandler(true)
  const packet6 = (<any> handler6)._packet
  const seqIn6 = (): number => (<any> handler6)._seq_in
  const seqOut6 = (): number => (<any> handler6)._seq_out

  const reply6 = (): Buffer => {
    const buffer = Buffer.from(handler6.outgoing())
    buffer.writeUInt8(0x81, 0) // type
    buffer.writeUInt16BE(0x00, 2) // checksum
    buffer.writeUInt16BE(seqOut6(), 6) // sequence
    buffer.writeUInt32BE(seqOut6(), 16) // sequence full
    buffer.writeUInt16BE(rfc1071crc(buffer), 2)
    return buffer
  }

  it('should prepare an outgoing ICMPv4 packet', () => {
    const buffer = handler4.outgoing()
    expect(seqOut4()).toEqual(1)

    const type = buffer.readUInt8(0)
    const code = buffer.readUInt8(1)
    const checksum = buffer.readUInt16BE(2)
    const identifier = buffer.readUInt16BE(4)
    const seq16 = buffer.readUInt16BE(6)
    const timestamp = buffer.readBigInt64BE(8)
    const sequence = buffer.readUint32BE(16)
    const correlation = buffer.subarray(20)

    expect(type).toEqual(0x08)
    expect(code).toEqual(0x00)
    expect(identifier).toEqual(process.pid % 0xFFFF)
    expect(seq16).toEqual(1) // first packet
    expect(Number(process.hrtime.bigint() - timestamp)).toBeGreaterThan(0)
    expect(Number(process.hrtime.bigint() - timestamp)).toBeLessThan(1000000)
    expect(sequence).toEqual(1) // first packet
    expect(correlation).toEqual(packet4.subarray(20))

    buffer.writeUInt16BE(0, 2)
    expect(checksum).toEqual(rfc1071crc(buffer))
  })

  it('should prepare an outgoing ICMPv6 packet', () => {
    const buffer = handler6.outgoing()
    expect(seqOut6()).toEqual(1)

    const type = buffer.readUInt8(0)
    const code = buffer.readUInt8(1)
    const checksum = buffer.readUInt16BE(2)
    const identifier = buffer.readUInt16BE(4)
    const seq16 = buffer.readUInt16BE(6)
    const timestamp = buffer.readBigInt64BE(8)
    const sequence = buffer.readUint32BE(16)
    const correlation = buffer.subarray(20)

    expect(type).toEqual(0x80)
    expect(code).toEqual(0x00)
    expect(identifier).toEqual(process.pid % 0xFFFF)
    expect(seq16).toEqual(1) // first packet
    expect(Number(process.hrtime.bigint() - timestamp)).toBeGreaterThan(0)
    expect(Number(process.hrtime.bigint() - timestamp)).toBeLessThan(1000000)
    expect(sequence).toEqual(1) // first packet
    expect(correlation).toEqual(packet6.subarray(20))

    buffer.writeUInt16BE(0, 2)
    expect(checksum).toEqual(rfc1071crc(buffer))
  })

  it('should handle an incoming ICMPv4 packet', () => {
    const buffer = reply4()
    const now = buffer.readBigInt64BE(8)

    expect(seqIn4()).not.toEqual(seqOut4())
    expect(handler4.incoming(buffer, now)).toEqual(0n)
    expect(seqIn4()).toEqual(seqOut4())
  })

  it('should handle an incoming ICMPv6 packet', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)

    expect(seqIn6()).not.toEqual(seqOut4())
    expect(handler6.incoming(buffer, now)).toEqual(0n)
    expect(seqIn6()).toEqual(seqOut4())
  })

  it('should handle an incoming IPv4 + ICMPv4 packet', () => {
    const icmp = reply4()
    const now = icmp.readBigInt64BE(8)

    const ip = Buffer.alloc(40).fill(0)
    ip.writeUint8(0x4A, 0)

    const buffer = Buffer.concat([ ip, icmp ])

    expect(seqIn4()).not.toEqual(seqOut4())
    expect(handler4.incoming(buffer, now)).toEqual(0n)
    expect(seqIn4()).toEqual(seqOut4())
  })

  it('should handle an incoming IPv6 + ICMPv6 packet', () => {
    const icmp = reply6()
    const now = icmp.readBigInt64BE(8)

    const ip = Buffer.alloc(40).fill(0)
    ip.writeUint8(0x60, 0)

    const buffer = Buffer.concat([ ip, icmp ])

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(0n)
    expect(seqIn6()).toEqual(seqOut6())
  })

  it('should not handle incoming short packets', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer.subarray(0, 63), now)).toEqual(-1n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with the wrong correlation', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.fill(0, 20, 64)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-2n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with the wrong type', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.writeUint8(0, 0)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-3n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with the wrong code', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.writeUint8(1, 1)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-4n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with the lower 16 sequence number', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.writeUint16BE(0, 6)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-5n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with sequence greater than last packet out', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.writeUint16BE(seqOut6() + 1, 6)
    buffer.writeUint32BE(seqOut6() + 1, 16)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-6n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with sequence less than last packet in', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.writeUint16BE(seqIn6() - 1, 6)
    buffer.writeUint32BE(seqIn6() - 1, 16)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-7n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })

  it('should not handle incoming packets with timestamp in the future', () => {
    const buffer = reply6()
    const now = buffer.readBigInt64BE(8)
    buffer.writeBigInt64BE(now + 1n, 8)

    expect(seqIn6()).not.toEqual(seqOut6())
    expect(handler6.incoming(buffer, now)).toEqual(-8n)
    expect(seqIn6()).not.toEqual(seqOut6())
  })
})
