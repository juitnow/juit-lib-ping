/** Marker type for the {@link AF_INET} and {@link AF_INET6} constants */
type af_family = number & { __af_family: never }

/** Type for our {@link open} callback */
type open_callback =
  | ((error: Error, fd: undefined) => void)
  | ((error: null, fd: number) => void)

/** Constant indicating that we are about to open an `ICMPv4` socket */
export const AF_INET: af_family
/** Constant indicating that we are about to open an `ICMPv6` socket */
export const AF_INET6: af_family

/** The version of the native addon that was loaded */
export const version: string

/**
 * Open an `ICMPv4` or `ICMPv6` socket optionally bound to the specified
 * IP address, and return its _file descriptor_ in a callback.
 *
 * @param family Either the constant {@link AF_INET} for `ICMPv4` or
 *               {@link AF_INET6} for `ICMPv6`
 * @param bind_address An _IP address_ (not a _host name_) the socked should be
 *                     bound to before being returned. This must be a valid
 *                     address for a local interface, or `null` or `undefined`.
 * @param callback The callback to invoke after the socket was opened and bound.
 */
export function open(
  family: af_family,
  bind_address: string | null | undefined,
  callback: open_callback
): void
