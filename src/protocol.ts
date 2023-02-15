/* ========================================================================== *
 * ICMP ECHO REQUEST / RESPONSE MESSAGES                                      *
 * ========================================================================== *
 *                                                                            *
 *                              PACKET STRUCTURE                              *
 *                                                                            *
 *                        0      1      2      3      4                       *
 *                      0 +------+------+------+------+                       *
 *                        | TYPE | CODE | CHECKSUM    |                       *
 *                      4 +------+------+------+------+                       *
 *                        | IDENTIFIER  | SEQUENCE    |                       *
 *                      8 +-------------+-------------+                       *
 *                        | PAYLOAD (timestamp)       |                       *
 *                        |                 (8 bytes) |                       *
 *                     16 +---------------------------+                       *
 *                        | PAYLOAD (full sequence)   |                       *
 *                        |                 (4 bytes) |                       *
 *                     20 +---------------------------+                       *
 *                        | PAYLOAD (correl. data)    |                       *
 *                        |                (48 bytes) |                       *
 *                     64 +---------------------------+                       *
 *                                                                            *
 *                               TYPES AND CODES                              *
 *                                                                            *
 *                   Type   | ECHO Request | Echo Response |                  *
 *                   -------+--------------+---------------+                  *
 *                   ICMPv4 | 0x08         | 0x00          |                  *
 *                   ICMPv6 | 0x80         | 0x81          |                  *
 *                   -------+--------------+---------------+                  *
 *                                                                            *
 * Description:                                                               *
 *                                                                            *
 * - Type:       kind of packet (ECHO Request/Response, ICMPv4/ICMPv6)        *
 * - Code:       always 0x00                                                  *
 * - Identifier: identifies the process ID sending the ECHO Request           *
 * - Sequence:   sequential number for correlating messages                   *
 * - Checksum:   calculated over the whole packet with checksum as zero       *
 * - Payload:    8 bytes timestamp in nanos, full sequence, correlation data  *
 *                                                                            *
 * We kind of like align with the normal "ping" utility that sends by default *
 * 64 bytes of data (including the 8 bytes ICMP header) and we fill the whole *
 * 56 bytes of payload with 8 bytes of timestamps in nanosecods,  followed by *
 * 54 bytes of "correlation data" (a random number).                          *
 *                                                                            *
 * ========================================================================== */

import { randomBytes } from 'node:crypto'

export const ERR_WRONG_LENGTH = -1n
export const ERR_WRONG_CORRELATION = -2n
export const ERR_WRONG_ICMP_TYPE = -3n
export const ERR_WRONG_ICMP_CODE = -4n
export const ERR_WRONG_SEQUENCE = -5n
export const ERR_SEQUENCE_TOO_BIG = -6n
export const ERR_SEQUENCE_TOO_SMALL = -7n
export const ERR_LATENCY_NEGATIVE = -8n

export function getWarning(num: bigint): { code: string, message: string } {
  if (num >= 0) return { code: 'OK', message: `Latency is ${Number(num) / 1000000} ms` }
  switch (num) {
    case ERR_WRONG_LENGTH: return { code: 'ERR_WRONG_LENGTH', message: 'Received packet with invalid length' }
    case ERR_WRONG_CORRELATION: return { code: 'ERR_WRONG_CORRELATION', message: 'Received packet with invalid correlation data' }
    case ERR_WRONG_ICMP_TYPE: return { code: 'ERR_WRONG_ICMP_TYPE', message: 'Received packet with invalid ICMP type' }
    case ERR_WRONG_ICMP_CODE: return { code: 'ERR_WRONG_ICMP_CODE', message: 'Received packet with invalid ICMP code' }
    case ERR_WRONG_SEQUENCE: return { code: 'ERR_WRONG_SEQUENCE', message: 'Received packet with mismatched sequence in header/payload' }
    case ERR_SEQUENCE_TOO_BIG: return { code: 'ERR_SEQUENCE_TOO_BIG', message: 'Received packet with sequence in the future' }
    case ERR_SEQUENCE_TOO_SMALL: return { code: 'ERR_SEQUENCE_TOO_SMALL', message: 'Received packet with sequence in the past (duplicate packet?)' }
    case ERR_LATENCY_NEGATIVE: return { code: 'ERR_LATENCY_NEGATIVE', message: 'Received packet with negative latence (time travel is possible!)' }
    default: return { code: 'ERR_UNKNOWN', message: `Unknown error code (code=${num})` }
  }
}

export class ProtocolHandler {
  private readonly __packet: Buffer = randomBytes(64)
  private readonly __type: number
  private __seq_out: number = 0
  private __seq_in: number = 0

  constructor(v6: boolean) {
    this.__type = (v6 ? 0x81 : 0x00)
    // type (0x80 for IPv6, 0x08 for IPv4), code (0x00), checksum (0x0000)
    this.__packet.writeUInt32BE(v6 ? 0x80000000 : 0x08000000, 0)
    // itentifier (process pid)
    this.__packet.writeUInt16BE(process.pid % 0x0ffff, 4)
    // sequence (for now set to 0)
    this.__packet.writeUInt16BE(this.__seq_out, 6)
    // timestamp (set to zero as well)
    this.__packet.writeBigUInt64BE(0n, 8)
  }

  outgoing(): Buffer {
    const buffer = Buffer.from(this.__packet)

    // Prep the sequence (full sequence and lower 16 bits)
    buffer.writeUInt32BE(++ this.__seq_out, 16)
    buffer.writeUInt16BE(this.__seq_out & 0x0ff, 6)

    // Prep the timestamp
    buffer.writeBigUInt64BE(process.hrtime.bigint(), 8)

    // Calculate the checksum
    buffer.writeUInt16BE(rfc1071crc(buffer), 2)

    // All done
    return buffer
  }

  incoming(buffer: Buffer, now: bigint = process.hrtime.bigint()): bigint {
    // if the buffer is _bigger_ then our fixed 64 bytes packet size, it might
    // be prepended by the IPv4 or IPv6 header (this happens on Macs)
    if (buffer.length > 64) {
      const first = buffer.readUInt8(0)
      const version = first >> 4

      if (version === 6) {
        // IPv6 is easy and has a fixed header length of 40 bytes, soo....
        if (buffer.length === 104) buffer = buffer.subarray(40)
      } else if (version === 4) {
        // IPv4 has a variable header length, the lower 4 bits of the first byte
        // indicate the length of the header in 32-bit (4-byte) words...
        const length = (first & 0xF) * 4
        if (buffer.length === (length + 64)) buffer = buffer.subarray(length)
      }
    }

    // If the buffer length is not 64 bytes after trimming above, we can
    // safely assume this is not an ECHO reply to one of our packets
    if (buffer.length !== 64) return ERR_WRONG_LENGTH

    // Compare the _correlation data_ part of the buffer to determine whether
    // this was a packet sent for us or not.... If not, ignore
    if (buffer.compare(this.__packet, 20, 64, 20, 64) !== 0) return ERR_WRONG_CORRELATION

    // Check the type, it _MUST_ be an echo reply (IPv4 or IPv6)
    const type = buffer.readUInt8(0)
    if (type !== this.__type) return ERR_WRONG_ICMP_TYPE

    // Check the code, it _MUST_ be 0x00
    const code = buffer.readUInt8(1)
    if (code !== 0x00) return ERR_WRONG_ICMP_CODE

    // Checksums on IPv6 require a "pseudo header" to be prepended so for now
    // we skip the whole shabang and ignore it... I assume the kernel checks...
    // const checksum = buffer.readUInt16BE(2)
    // const computedChecksum = rfc1071crc(buffer)
    // if (checksum != computedChecksum) return

    // Identifier seems to get messed up on Linux IPv6 when pinging localhost,
    // so we ignore this too, and simply rely on out _correlation data_ above...
    // const identifier = buffer.readUInt16BE(4)
    // if (identifier != this._id) return

    // Check the sequence, as it's monotonic we can discard values greater than
    // the last we sent out, or lower-or-equal than the last one we received...
    const sequence = buffer.readUInt32BE(16) // this is in our "payload"

    // Sequence in the ICMP header is 16 bits, but as some kernels only return
    // the lower 8 bits on ECHO Reply packets, so only match the lower 8 bits...
    if ((buffer.readUInt16BE(6) & 0xFF) != (sequence & 0xFF)) return ERR_WRONG_SEQUENCE

    // If the full sequence is greater than whatever we sent out, we ignore
    if (sequence > this.__seq_out) return ERR_SEQUENCE_TOO_BIG

    // If the full sequence is lower (or equal) to the last one received this
    // means we received either a duplicate packet, or an out of order one
    if (sequence <= this.__seq_in) return ERR_SEQUENCE_TOO_SMALL

    // Calculate the delta-time in nanoseconds, if negative obviously ignore
    const latency = now - buffer.readBigInt64BE(8)
    if (latency < 0n) return ERR_LATENCY_NEGATIVE

    // Store the last sequence number and return our latency
    this.__seq_in = sequence
    return latency
  }
}

export function rfc1071crc(buffer: Buffer): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i += 2) {
    sum = (sum + buffer.readUInt16BE(i)) % 0xFFFF
  }
  return (~sum) & 0xFFFF
}
