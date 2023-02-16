// standard lib imports
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <net/if.h>

// node/libuv imports
#include <node_api.h>
#include <uv.h>

// should be defined by gyp
#ifndef ADDON_VERSION
#define ADDON_VERSION "0.0.0"
#endif

// define a string for the "interface name too long" message
#define __STR_HELPER(x) #x
#define __TO_STR(x) __STR_HELPER(x)
#define __ERR_SOURCE_INTERFACE_NAME_TOO_LONG \
  "Source interface must be at most " \
  __TO_STR(IFNAMSIZ) \
  " characters long"

/* ========================================================================== *
 * NAPI_CALL_VALUE / NAPI_CALL_VOID: wrapper to throw exception when a        *
 * `napi_...` call returns something different from `napi_ok`                 *
 * ========================================================================== */

/** Throw an error, used by NAPI_CALL_VALUE / NAPI_CALL_VOID */
static void _napi_call_error(
  napi_env _env,
  napi_status _status,
  const char * _call,
  int _line
) {
  if (_status == napi_ok) return;

  // Get the extended error info from the latest `napi_...` call
  const napi_extended_error_info* __error_info = NULL;
  _status = napi_get_last_error_info(_env, &__error_info);

  // Get the error message from the `napi_extended_error_info`
  const char *__error_message = NULL;
  if ((_status == napi_ok) && (__error_info->error_message != NULL)) {
    __error_message = __error_info->error_message;
  } else {
    __error_message = "Unknown Error";
  }

  // If no exception is pending already, create an error and throw it
  bool __is_pending = 0;
  _status = napi_is_exception_pending(_env, &__is_pending);
  if ((_status == napi_ok) && (__is_pending == 0)) {
    char __buffer[128];
    snprintf(__buffer, sizeof(__buffer), "%s (%s, line=%d)", __error_message, _call, _line);
    napi_throw_error(_env, NULL, __buffer);
  }
}

/** Wrap a call to a `napi_...` function and throw + return NULL on failure */
#define NAPI_CALL_VALUE(_call, _env, ...) \
  do { \
    napi_status __status = _call(_env, __VA_ARGS__); \
    if (__status == napi_ok) break; \
    _napi_call_error(_env, __status, #_call, __LINE__); \
    return NULL; \
  } while (0);

/** Wrap a call to a `napi_...` function and throw + return on failure */
#define NAPI_CALL_VOID(_call, _env, ...) \
  do { \
    napi_status __status = _call(_env, __VA_ARGS__); \
    if (__status == napi_ok) break; \
    _napi_call_error(_env, __status, #_call, __LINE__); \
    return; \
  } while (0);

/* ========================================================================== */

/** Create a _system_ error, from a standard (or `libuv`) errno */
static napi_value _system_error(
  napi_env _env,
  const char * _syscall,
  int _errno
) {
  const char * __message_chars = NULL;
  const char * __code_chars = NULL;

  // Our `errno` is very likely a system errno, let's translate it to a libuv
  // error and get the message / code, otherwise it's "unknown"...
  if (_errno != 0) {
    const int __errno = uv_translate_sys_error(_errno);
    __message_chars = uv_strerror(__errno);
    __code_chars = uv_err_name(__errno);
  } else {
    __message_chars = "Unknown Error";
  }

  // Convert message and code into JS strings
  napi_value __message = NULL;
  if (__message_chars != NULL) {
    NAPI_CALL_VALUE(napi_create_string_latin1, _env, __message_chars, NAPI_AUTO_LENGTH, &__message);
  }

  napi_value __code = NULL;
  if (__code_chars != NULL) {
    NAPI_CALL_VALUE(napi_create_string_latin1, _env, __code_chars, NAPI_AUTO_LENGTH, &__code);
  }

  // Create our error object
  napi_value __error = NULL;
  NAPI_CALL_VALUE(napi_create_error, _env, __code, __message, &__error);

  // Inject the "errno" property in our error
  napi_value __errno = NULL;
  NAPI_CALL_VALUE(napi_create_uint32, _env, _errno, &__errno);
  NAPI_CALL_VALUE(napi_set_named_property, _env, __error, "errno", __errno);

  // If we know the syscall, inject that as a string into our error
  if (_syscall != NULL) {
    napi_value __syscall = NULL;
    NAPI_CALL_VALUE(napi_create_string_latin1, _env, _syscall, NAPI_AUTO_LENGTH, &__syscall);
    NAPI_CALL_VALUE(napi_set_named_property, _env, __error, "syscall", __syscall);
  }

  // Return our error
  return __error;
}

/* ========================================================================== */

/** Throw a type error with a specified message */
static void _throw_type_error(
  napi_env _env,
  const char *_message
) {
  bool __is_pending = false;
  napi_status __status = napi_is_exception_pending(_env, &__is_pending);
  if ((__status == napi_ok) && (__is_pending == false)) {
    const char *__message = (_message == NULL) ? "" : _message;
    napi_throw_type_error(_env, NULL, __message);
  }
}

/** Throw a system error from a syscall name and errno code */
static void _throw_system_error(
  napi_env _env,
  const char * _syscall,
  int _errno
) {
  bool __is_pending = false;
  napi_status __status = napi_is_exception_pending(_env, &__is_pending);
  if ((__status == napi_ok) && (__is_pending == false)) {
    napi_value __error = _system_error(_env, _syscall, _errno);
    if (__error != NULL) {
      napi_throw(_env, __error);
    } else {
      char __message[128];
      if (_syscall == NULL) {
        snprintf(__message, sizeof(__message), "System error (errno=%d)", _errno);
      } else {
        snprintf(__message, sizeof(__message), "System error (syscall=%s errno=%d)", _syscall, _errno);
      }
      napi_throw_type_error(_env, NULL, __message);
    }
  }
}

/* ========================================================================== *
 * OPEN: asynchronously open our socket                                       *
 * ========================================================================== */

/** Data to pass around in `open` asynchronous work */
struct _open_data {
  /** The `napi_async_work` structure associated with this `open` operation */
  napi_async_work __async_work;
  /** A reference to the JavaScript callback function to invoke after `open` */
  napi_ref __callback_ref;
  /** The _size_ of the `__sockaddr` union below, or `0` we shouldn't bind */
  size_t __sockaddr_size;
  /** The _family_ of the socket to use and (optionally) the bind address */
  union {
    /**
     * Generic `sockaddr` stucture for both IPv4 and IPv6.
     *
     * The `sa_family` must be set to `AF_INET` for IPv4 or `AF_INET6` for IPv6.
     */
    struct sockaddr __sockaddr;
    struct sockaddr_in __sockaddr_in4_addr;
    struct sockaddr_in6 __sockaddr_in6_addr;
  };
  /** The length of interface name to bind to, or zero if no device */
  size_t __interface_length;
  /** The actual name of the interface to bind to (with null terminator) */
  char __interface[IFNAMSIZ + 1];
  /** Either NULL or the name of the sytem call that failed */
  const char * __syscall;
  /** Either `0` or the `errno` from the sytem call that failed */
  int __errno;
  /** The file descriptor of the open socket or `-1` on error */
  int __fd;
};

/* ========================================================================== */

/** Inject an error in our data structure and close the socket (if opened) */
static void _open_execute_fail(
  napi_env _env,
  struct _open_data *_data,
  const char *_syscall,
  int _errno
) {
  int __socket = _data->__fd;

  _data->__syscall = _syscall;
  _data->__errno = errno;
  _data->__fd = -1;

  if (__socket > 1) return;

  close(__socket);
}

/**
 * Asynchronously open an ICMP socket and (optionally) bind it to a source
 * interface and assign a from address.
 */
static void _open_execute(
  napi_env _env,
  void *_data
) {
  struct _open_data * __data = (struct _open_data *) _data;

  // The proto is `IPPROTO_ICMP` or `IPPROTO_ICMPV6` depending on the family
  int __protocol = 0;
  if (__data->__sockaddr.sa_family == AF_INET) {
    __protocol = IPPROTO_ICMP;
  } else if (__data->__sockaddr.sa_family == AF_INET6) {
    __protocol = IPPROTO_ICMPV6;
  } else {
    // Whops, unknown or unsupported address family
    __data->__errno = EAFNOSUPPORT;
    __data->__fd = -1;
    return;
  }

  // Open the socket and get the file descriptor
  __data->__fd = socket(__data->__sockaddr.sa_family, SOCK_DGRAM, __protocol);
  if (__data->__fd < 0) return _open_execute_fail(_env, __data, "socket", errno);

  // Optionally bind to an interface
  if (__data->__interface_length > 0) {
    #ifdef __linux__
      // On Linux, use "setsockopt" to bind directly to the interface
      int __result = setsockopt(
        __data->__fd,
        SOL_SOCKET,
        SO_BINDTODEVICE,
        __data->__interface,
        __data->__interface_length
      );

      if (__result < 0) return _open_execute_fail(_env, __data, "setsockopt", errno);
    #endif // ifdef __linux__

    #ifdef __APPLE__
      // On Macs, first we have to figure out the interface index
      int __index = if_nametoindex(__data->__interface);
      if (__index == 0) return _open_execute_fail(_env, __data, "if_nametoindex", errno);

      // Then determine the sockopt level and option (depends on IPv4/IPv6)
      int __level;
      int __option;
      if (__data->__sockaddr.sa_family == AF_INET) {
        __level = IPPROTO_IP;
        __option = IP_BOUND_IF;
      } else { // we checked sa_family before opening the socket
        __level = IPPROTO_IPV6;
        __option = IPV6_BOUND_IF;
      }

      // Finally we can call "setsockopt" with the correct level, option, and interface index
      int __result = setsockopt(__data->__fd, __level, __option, &__index, sizeof(__index));
      if (__result < 0) return _open_execute_fail(_env, __data, "setsockopt", errno);
    #endif // ifdef __APPLE__
  }

  // Optionally specify the from address
  if (__data->__sockaddr_size > 0) {
    int __result = bind(__data->__fd, &__data->__sockaddr, __data->__sockaddr_size);
    if (__result != 0) _open_execute_fail(_env, __data, "bind", errno);
  }
}

/* ========================================================================== */

/** Complete our call to open a socket and invoke the JavaScript callback */
static void _open_complete(
  napi_env _env,
  napi_status _status,
  void* data
) {
  // Copy the data allocated in `_open` and free its pointer
  struct _open_data __data;
  memcpy(&__data, data, sizeof(struct _open_data));
  free(data);

  // Get JS's `null` and `undefined`, then prep the arguments for the callback
  napi_value __args[2];
  NAPI_CALL_VOID(napi_get_null, _env, &__args[0]);
  NAPI_CALL_VOID(napi_get_undefined, _env, &__args[1]);

  // If we have a negative file descriptor, we have an error and pass it to our
  // callback as the _first_ argument, otherwise we pass the file descriptor as
  // the second argument to the callback.
  if (_status != napi_ok) {
    char __message_chars[128];
    snprintf(__message_chars, sizeof(__message_chars), "NAPI error opening (status=%d)", _status);

    napi_value __message = NULL;
    NAPI_CALL_VOID(napi_create_string_latin1, _env, __message_chars, NAPI_AUTO_LENGTH, &__message);

    NAPI_CALL_VOID(napi_create_error, _env, NULL, __message, &__args[0]);
  } else if (__data.__fd < 0) {
    __args[0] = _system_error(_env, __data.__syscall, __data.__errno);
  } else {
    NAPI_CALL_VOID(napi_create_uint32, _env, __data.__fd, &__args[1]);
  }

  // Get our callback function
  napi_value __callback = NULL;
  NAPI_CALL_VOID(napi_get_reference_value, _env, __data.__callback_ref, &__callback);

  // Call our callback with our arguments, scoped in `global`
  napi_value __global = NULL;
  NAPI_CALL_VOID(napi_get_global, _env, &__global);
  NAPI_CALL_VOID(napi_call_function, _env, __global, __callback, 2, __args, NULL);

  // Cleanup: delete reference to our callback and our async work
  NAPI_CALL_VOID(napi_delete_reference, _env, __data.__callback_ref);
  NAPI_CALL_VOID(napi_delete_async_work, _env, __data.__async_work);
}

/* ========================================================================== */

/** Initiate our asynchronous `open` call */
static napi_value _open(
  napi_env _env,
  napi_callback_info _info
) {
  napi_valuetype __type = napi_undefined;

  // Allocate _open_data here, it'll be malloc'ed later
  struct _open_data __data;
  bzero(&__data, sizeof(struct _open_data));

  // Get our `open` call arguments
  size_t __argc = 4;
  napi_value __args[4];
  NAPI_CALL_VALUE(napi_get_cb_info, _env, _info, &__argc, __args, NULL, NULL);

  if (__argc != 4) {
    _throw_type_error(_env, "Expected 4 arguments: socket family, from address, source interface, callback");
    return NULL;
  }

  napi_value __socket_family = __args[0];
  napi_value __from_address = __args[1];
  napi_value __source_interface = __args[2];
  napi_value __callback = __args[3];

  // Get the socket's family (should be AF_INET or AF_INET6)
  NAPI_CALL_VALUE(napi_typeof, _env, __socket_family, &__type);
  if (__type != napi_number) {
    _throw_type_error(_env, "Specified socket family is not a number");
    return NULL;
  }

  // Validate the socket family (must be AF_INET or AF_INET6) and remember our
  // socket protocol (which must be IPPROTO_ICMP or IPPROTO_ICMPV6 accordingly).
  int __sa_family = -1;
  NAPI_CALL_VALUE(napi_get_value_int32, _env, __socket_family, &__sa_family);
  void * __from_address_ptr = NULL;

  if (__sa_family == AF_INET) {
    __data.__sockaddr.sa_family = AF_INET;
    __data.__sockaddr_size = sizeof(struct sockaddr_in);
    __from_address_ptr = &__data.__sockaddr_in4_addr.sin_addr;
  } else if (__sa_family == AF_INET6) {
    __data.__sockaddr.sa_family = AF_INET6;
    __data.__sockaddr_size = sizeof(struct sockaddr_in6);
    __from_address_ptr = &__data.__sockaddr_in6_addr.sin6_addr;
  } else {
    _throw_type_error(_env, "Socket family must be AF_INET or AF_INET6");
    return NULL;
  }

  // Get the address to bind to (if any)
  NAPI_CALL_VALUE(napi_typeof, _env, __from_address, &__type);
  if ((__type == napi_null) || (__type == napi_undefined)) {
    __data.__sockaddr_size = 0; // no binding!
  } else if (__type != napi_string) {
    _throw_type_error(_env, "From address must be a string, null or undefined");
    return NULL;
  } else {
    // Figure out the `in(6)_addr` structure for the address to bind to
    char __buffer[42];
    bzero(__buffer, 42);
    size_t __size = 42;

    // Convert the address string into a C string
    NAPI_CALL_VALUE(napi_get_value_string_latin1, _env, __from_address, __buffer, __size, &__size);

    // Check that the address is actually of the correct length
    if (__size > 40) {
      _throw_type_error(_env, "From address must be at most 40 characters long");
    }

    // Convert the C string into a network address and check the result
    int __result = inet_pton(__sa_family, __buffer, __from_address_ptr);
    if (__result < 0) {
      _throw_system_error(_env, "inet_pton", errno);
      return NULL;
    } else if (__result == 0) {
      char __message[128];
      const char *__format =
        __sa_family == AF_INET ? "Invalid IPv4 from address: %s" :
        __sa_family == AF_INET6 ? "Invalid IPv6 from address: %s" :
        "Invalid from address: %s";

      snprintf(__message, sizeof(__message), __format, __buffer);
      _throw_type_error(_env, __message);
      return NULL;
    }
  }

  // Get the interface to bind to (if any)
  NAPI_CALL_VALUE(napi_typeof, _env, __source_interface, &__type);
  if ((__type == napi_null) || (__type == napi_undefined)) {
    __data.__interface_length = 0; // no interface binding!
  } else if (__type != napi_string) {
    _throw_type_error(_env, "Source interface must be a string, null or undefined");
    return NULL;
  } else {
    // Figure out the `in(6)_addr` structure for the address to bind to
    char __buffer[IFNAMSIZ + 2];
    bzero(__buffer, IFNAMSIZ + 2);
    size_t __size = IFNAMSIZ + 2;

    // Convert the address string into a C string
    NAPI_CALL_VALUE(napi_get_value_string_latin1, _env, __source_interface, __buffer, __size, &__size);

    // Check that the address is actually of the correct length
    if (__size > IFNAMSIZ) {
      _throw_type_error(_env, __ERR_SOURCE_INTERFACE_NAME_TOO_LONG);
      return NULL;
    }

    // Copy the interface name into our data structure
    memcpy(__data.__interface, __buffer, __size + 1);
    __data.__interface_length = __size;
  }

  // Get the type of our last argument, which must be a function
  NAPI_CALL_VALUE(napi_typeof, _env, __callback, &__type);

  if (__type != napi_function) {
    _throw_type_error(_env, "Specified callback is not a function");
    return NULL;
  }

  // Create a reference to our callback function
  NAPI_CALL_VALUE(napi_create_reference, _env, __callback, 1, &__data.__callback_ref);

  // Create a resource and resource name for our async work
  napi_value __resource = NULL;
  napi_value __resource_name = NULL;

  NAPI_CALL_VALUE(napi_create_object, _env, &__resource);
  NAPI_CALL_VALUE(napi_create_string_latin1, _env, "ping_open", NAPI_AUTO_LENGTH, &__resource_name);

  // Allocate _now_ the real `_open_data` structure. We do it here because if
  // there are errors above we won't leak memory...
  struct _open_data * __data_ptr = malloc(sizeof(struct _open_data));
  memcpy(__data_ptr, &__data, sizeof(struct _open_data));

  // Create our async work to be queued
  NAPI_CALL_VALUE(napi_create_async_work,
                  _env,
                  __resource,
                  __resource_name,
                  &_open_execute,
                  &_open_complete,
                  __data_ptr,
                  &__data_ptr->__async_work);

  // Queue up our async work
  NAPI_CALL_VALUE(napi_queue_async_work, _env, __data_ptr->__async_work);

  // Return JS `undefined`
  return NULL;
}

/* ========================================================================== *
 * init: initialize the addon, injecting our properties in the `exports`      *
 * ========================================================================== */
static napi_value init(napi_env _env, napi_value _exports) {
  napi_value __version = NULL;
  NAPI_CALL_VALUE(napi_create_string_latin1, _env, ADDON_VERSION, NAPI_AUTO_LENGTH, &__version);
  NAPI_CALL_VALUE(napi_set_named_property, _env, _exports, "version", __version);

  napi_value __af_inet = NULL;
  NAPI_CALL_VALUE(napi_create_uint32, _env, AF_INET, &__af_inet);
  NAPI_CALL_VALUE(napi_set_named_property, _env, _exports, "AF_INET", __af_inet);

  napi_value __af_inet6 = NULL;
  NAPI_CALL_VALUE(napi_create_uint32, _env, AF_INET6, &__af_inet6);
  NAPI_CALL_VALUE(napi_set_named_property, _env, _exports, "AF_INET6", __af_inet6);

  napi_value __open_fn = NULL;
  NAPI_CALL_VALUE(napi_create_function, _env, "open", NAPI_AUTO_LENGTH, _open, NULL, &__open_fn);
  NAPI_CALL_VALUE(napi_set_named_property, _env, _exports, "open", __open_fn);

  NAPI_CALL_VALUE(napi_object_freeze, _env, _exports);
  return _exports;
}

/* Define `init` as the entry point for our module */
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
