{
  # Variables: read "addon_version" from our package.json's "version" field
  "variables": {
    "addon_version": "<!(node -p \"require('../package.json').version\")",
    # The "node_os_platform" is either "linux" or "darwin" from `os.platform()`
    # See https://nodejs.org/api/os.html#osplatform
    "node_os_platform": "<(OS)",
    # The "node_os_arch" is either "x64" or "arm64" from `os.arch()`
    # See https://nodejs.org/api/os.html#osarch
    "node_os_arch": "<(target_arch)"
  },

  # Fixup variables
  "conditions": [
    [ "OS=='mac'",             { "variables": { "node_os_platform": "darwin" } } ],
    [ "target_arch=='x86_64'", { "variables": { "node_os_arch":     "x64"    } } ],
  ],

  "targets": [ {
    # Build "ping.node" in the "./build/Release" directory
    "target_name": "ping",
    "sources": [ "ping.c" ],
    "defines": [ "ADDON_VERSION=\"<(addon_version)\"" ],
    "cflags": [ "-Wstrict-prototypes" ],
    "ldflags": [ "-s" ],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "20.0",
      "OTHER_CFLAGS": [ "-Wstrict-prototypes" ],
    }
  }, {
    # Copy "ping.node" into "./platform-arch/ping.node"
    "target_name": "copy_binary",
    "type": "none",
    "dependencies" : [ "ping" ],
    "copies": [ {
      "files": [ "<(module_root_dir)/build/Release/ping.node" ],
      "destination": "<(module_root_dir)/<(node_os_platform)-<(node_os_arch)",
    } ],
  } ]
}
