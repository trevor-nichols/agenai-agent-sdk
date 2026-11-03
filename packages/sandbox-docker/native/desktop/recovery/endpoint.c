#include "recovery.h"
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

bool recovery_peer(struct recovery *r, struct json *j, struct coordinator_failure *f) {
    struct stat before, after;
    char physical[4096], current[4096];
    if (!realpath(r->endpoint, physical)) return coordinator_error(f, "endpoint_resolve", false);
    if (lstat(physical, &before) < 0) return coordinator_error(f, "endpoint_stat", false);
    if (!S_ISSOCK(before.st_mode) || before.st_uid != getuid()) return recovery_fail(f, "endpoint_identity");
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    size_t length = strlen(physical);
    if (length >= sizeof(address.sun_path)) return recovery_fail(f, "endpoint_path_bound");
    memcpy(address.sun_path, physical, length + 1U); address.sun_len = (uint8_t)(offsetof(struct sockaddr_un, sun_path) + length + 1U);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return coordinator_error(f, "endpoint_socket", false);
    if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0 || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) { close(fd); return coordinator_error(f, "endpoint_flags", false); }
    if (connect(fd, (struct sockaddr *)&address, address.sun_len) < 0) {
        if (errno != EINPROGRESS) { close(fd); return coordinator_error(f, "endpoint_connect", false); }
        struct pollfd pending = { .fd = fd, .events = POLLOUT }; int result;
        do { result = poll(&pending, 1U, 5000); } while (result < 0 && errno == EINTR);
        int error = 0; socklen_t error_size = sizeof(error);
        if (result <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &error_size) < 0 || error != 0) {
            close(fd); errno = error ? error : ETIMEDOUT; return coordinator_error(f, "endpoint_connect", false);
        }
    }
    pid_t pid; socklen_t pid_length = sizeof(pid); audit_token_t token; socklen_t token_length = sizeof(token);
    bool ok = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pid_length) == 0 && pid_length == sizeof(pid)
        && getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_length) == 0 && token_length == sizeof(token);
    close(fd);
    if (!ok) return coordinator_error(f, "endpoint_peer_token", false);
    if (audit_token_to_pid(token) != pid || audit_token_to_euid(token) != getuid()) return recovery_fail(f, "endpoint_peer_identity");
    struct process_fact processes[RECOVERY_PROCESS_MAX]; size_t count;
    if (!recovery_processes(r, processes, &count, CENSUS_CURRENT, f)) return false;
    bool backend = false;
    for (size_t i = 0; i < count; i++) if (processes[i].pid == pid && strcmp(recovery_images[processes[i].image].role, "backend") == 0) backend = true;
    if (!backend) return recovery_fail(f, "endpoint_peer_role");
    if (!realpath(r->endpoint, current) || strcmp(current, physical) != 0 || lstat(current, &after) < 0
        || !coordinator_same(&before, &after)) return recovery_fail(f, "endpoint_replaced");
    json_raw(j, "{\"pid\":%d,\"pidVersion\":%u,\"uid\":%u,\"device\":\"%llu\",\"inode\":\"%llu\"}", pid,
        audit_token_to_pidversion(token), audit_token_to_euid(token), (unsigned long long)before.st_dev, (unsigned long long)before.st_ino);
    return true;
}
