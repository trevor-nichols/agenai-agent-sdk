"""Trusted pre-exec enrollment; the target never receives cgroup control paths."""
import json
import os
import sys

with os.fdopen(3) as recipe_file:
    configuration = json.load(recipe_file)
with open(configuration["cgroup"] + "/cgroup.procs", "w", encoding="ascii") as membership:
    membership.write(str(os.getpid()))
arguments = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc",
             "--unshare-uts", "--unshare-cgroup", "--new-session", "--die-with-parent",
             "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr",
             "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
             "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev",
             "--tmpfs", "/sys", "--tmpfs", "/run", "--tmpfs", "/tmp"]
if not configuration["network"]:
    arguments.append("--unshare-net")
for mount in configuration["mounts"]:
    arguments.extend(["--bind" if mount["writable"] else "--ro-bind", mount["path"], mount["path"]])
for network_input in configuration["networkInputs"]:
    arguments.extend(["--ro-bind", network_input["source"], network_input["destination"]])
recipe = configuration["recipe"]
arguments.append("--clearenv")
for key, value in recipe["env"].items():
    arguments.extend(["--setenv", key, value])
arguments.extend(["--chdir", recipe["cwd"]])
# bwrap reads literal NUL-delimited arguments from an inherited descriptor. This
# keeps provider environment values out of supervisor argv and prevents loader
# variables from affecting the trusted pre-sandbox bwrap executable.
argument_fd = os.memfd_create("agenai-execution-arguments", flags=0)
os.write(argument_fd, b"\0".join(value.encode() for value in arguments[1:]) + b"\0")
os.lseek(argument_fd, 0, os.SEEK_SET)
os.execve(arguments[0], [arguments[0], "--args", str(argument_fd), "--", recipe["executable"], *recipe["args"]],
          {"PATH": "/usr/bin:/bin"})
