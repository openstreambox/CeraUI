"""Private-bus logind fixture: only Inhibit is implemented; no power methods."""
import ctypes as c
import os
import select
import sys

lib = c.CDLL('libsystemd.so.0')
ptr = c.c_void_p
for name, args, result in [
    ('sd_bus_new', [c.POINTER(ptr)], c.c_int),
    ('sd_bus_set_address', [ptr, c.c_char_p], c.c_int),
    ('sd_bus_set_bus_client', [ptr, c.c_int], c.c_int),
    ('sd_bus_start', [ptr], c.c_int),
    ('sd_bus_request_name', [ptr, c.c_char_p, c.c_uint64], c.c_int),
    ('sd_bus_message_is_method_call', [ptr, c.c_char_p, c.c_char_p], c.c_int),
    ('sd_bus_message_read_basic', [ptr, c.c_char, ptr], c.c_int),
    ('sd_bus_process', [ptr, ptr], c.c_int),
    ('sd_bus_flush', [ptr], c.c_int),
]:
    fn = getattr(lib, name)
    fn.argtypes, fn.restype = args, result
lib.sd_bus_reply_method_return.argtypes = [ptr, c.c_char_p]
lib.sd_bus_reply_method_return.restype = c.c_int
callback_type = c.CFUNCTYPE(c.c_int, ptr, ptr, ptr)
lib.sd_bus_add_object.argtypes = [ptr, ptr, c.c_char_p, callback_type, ptr]
lib.sd_bus_add_object.restype = c.c_int
readers = []

@callback_type
def method(message, userdata, error):
    if lib.sd_bus_message_is_method_call(message, b'org.freedesktop.login1.Manager', b'Inhibit') <= 0:
        return 0
    values = []
    for _ in range(4):
        value = c.c_char_p()
        assert lib.sd_bus_message_read_basic(message, b's', c.byref(value)) > 0
        values.append(value.value.decode())
    assert values == ['shutdown', 'CeraUI', 'Streaming or carrying client traffic', 'block'], values
    read_fd, write_fd = os.pipe()
    assert lib.sd_bus_reply_method_return(message, b'h', c.c_int(write_fd)) >= 0
    lib.sd_bus_flush(bus)
    os.close(write_fd)
    readers.append(read_fd)
    print('taken', flush=True)
    return 1

bus = ptr()
assert lib.sd_bus_new(c.byref(bus)) >= 0
assert lib.sd_bus_set_address(bus, sys.argv[1].encode()) >= 0
assert lib.sd_bus_set_bus_client(bus, 1) >= 0
assert lib.sd_bus_start(bus) >= 0
assert lib.sd_bus_request_name(bus, b'org.freedesktop.login1', 0) >= 0
assert lib.sd_bus_add_object(bus, None, b'/org/freedesktop/login1', method, None) >= 0
print('ready', flush=True)
while True:
    while lib.sd_bus_process(bus, None) > 0:
        pass
    for fd in list(readers):
        if select.select([fd], [], [], .01)[0] and not os.read(fd, 1):
            readers.remove(fd)
            os.close(fd)
            print('released', flush=True)
    select.select([], [], [], .01)
