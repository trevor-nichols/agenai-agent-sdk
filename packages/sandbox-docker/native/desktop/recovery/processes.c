#include "recovery.h"
#include "profile.h"
#include <errno.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/un.h>
#include <unistd.h>

static int image_index(const char *path) {
    char expected[4096];
    for (size_t i = 0; i < recovery_image_count; i++) {
        snprintf(expected, sizeof(expected), "%s/%s", RECOVERY_APPLICATION, recovery_images[i].relative);
        if (strcmp(path, expected) == 0) return (int)i;
    }
    return -1;
}
static bool still_alive(pid_t pid) {
    struct proc_bsdinfo b;
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &b, sizeof(b)) == sizeof(b) && b.pbi_status != SZOMB;
}
static bool executable_path(pid_t pid, char path[PROC_PIDPATHINFO_MAXSIZE], struct coordinator_failure *f) {
    if (proc_pidpath(pid, path, PROC_PIDPATHINFO_MAXSIZE) > 0) return true;
    if (errno != ENOENT) return coordinator_error(f, "process_path_census", false);
    // The kernel retains the exec path even after its executable vnode is unlinked.
    size_t length = 1048576U; char *bytes = malloc(length);
    if (!bytes) return coordinator_error(f, "process_arguments_allocation", false);
    int mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
    if (sysctl(mib, 3U, bytes, &length, NULL, 0) < 0) { free(bytes); return coordinator_error(f, "process_exec_path", false); }
    size_t n = length > sizeof(int) ? strnlen(bytes + sizeof(int), length - sizeof(int)) : 0;
    bool ok = n > 0 && n < PROC_PIDPATHINFO_MAXSIZE && n < length - sizeof(int) && bytes[sizeof(int)] == '/';
    if (ok) memcpy(path, bytes + sizeof(int), n + 1U);
    free(bytes); return ok ? true : recovery_fail(f, "process_exec_path_bound");
}
static bool socket_clients(struct recovery *r, pid_t pid, bool known, struct coordinator_failure *f) {
    errno = 0;
    int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (size < 0 || size > (int)(16384U * sizeof(struct proc_fdinfo))) return recovery_fail(f, "process_fd_bound");
    if (size == 0) return errno == 0 || !still_alive(pid) ? true : coordinator_error(f, "process_fd_census", false);
    size_t capacity = (size_t)size + 64U * sizeof(struct proc_fdinfo);
    if (capacity > 16384U * sizeof(struct proc_fdinfo)) capacity = 16384U * sizeof(struct proc_fdinfo);
    struct proc_fdinfo *fds = malloc(capacity); if (!fds) return coordinator_error(f, "process_fd_allocation", false);
    int got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)capacity);
    if (got < 0 || got >= (int)capacity || got % (int)sizeof(*fds) != 0) { free(fds); return recovery_fail(f, "process_fd_census"); }
    for (size_t i = 0; i < (size_t)got / sizeof(*fds); i++) if (fds[i].proc_fdtype == PROX_FDTYPE_SOCKET) {
        struct socket_fdinfo socket;
        int n = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &socket, sizeof(socket));
        if (n != sizeof(socket)) {
            if (errno == EBADF || errno == ESRCH || !still_alive(pid)) continue;
            free(fds); return coordinator_error(f, "socket_census", false);
        }
        if (socket.psi.soi_family != AF_UNIX || socket.psi.soi_kind != SOCKINFO_UN) continue;
        const struct un_sockinfo *u = &socket.psi.soi_proto.pri_un;
        const char *remote = u->unsi_caddr.ua_sun.sun_path;
        if (strnlen(remote, sizeof(u->unsi_caddr.ua_sun.sun_path)) == sizeof(u->unsi_caddr.ua_sun.sun_path)) { free(fds); return recovery_fail(f, "socket_path_bound"); }
        struct stat endpoint, connected;
        bool same_endpoint = strcmp(remote, r->endpoint) == 0 || (*remote && stat(remote, &connected) == 0
            && stat(r->endpoint, &endpoint) == 0 && S_ISSOCK(connected.st_mode) && coordinator_same(&connected, &endpoint));
        if (same_endpoint && !known && pid != getpid()) { free(fds); return recovery_fail(f, "unknown_socket_client"); }
    }
    free(fds); return true;
}
static bool same_lifetime(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_uid == b->pbi_uid && a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static bool epoch_events(int queue, uint32_t *flags, struct coordinator_failure *f) {
    struct kevent event; struct timespec immediate = {0}; int n;
    do { n = kevent(queue, NULL, 0, &event, 1, &immediate); } while (n < 0 && errno == EINTR);
    if (n < 0) return coordinator_error(f, "process_epoch_events", false);
    if (n && ((event.flags & EV_ERROR) != 0 || event.filter != EVFILT_PROC)) return recovery_fail(f, "process_epoch_event");
    *flags = n ? event.fflags : 0; return true;
}
enum process_observation recovery_process(struct recovery *r, pid_t pid, struct process_fact *out,
    enum census_mode mode, struct coordinator_failure *f) {
    struct proc_bsdinfo initial; errno = 0;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &initial, sizeof(initial)) != sizeof(initial)) {
        if (errno == ESRCH || errno == ENOENT) return PROCESS_ABSENT;
        coordinator_error(f, "process_identity_census", false); return PROCESS_INVALID;
    }
    if (initial.pbi_uid != getuid() || initial.pbi_status == SZOMB) return PROCESS_ABSENT;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (!executable_path(pid, path, f)) {
        if (!still_alive(pid)) { *f = (struct coordinator_failure){0}; return PROCESS_ABSENT; }
        return PROCESS_INVALID;
    }
    if (image_index(path) < 0 && strncmp(path, RECOVERY_APPLICATION "/", sizeof(RECOVERY_APPLICATION)) != 0)
        return socket_clients(r, pid, false, f) ? PROCESS_OTHER : PROCESS_INVALID;

    int queue = kqueue();
    if (queue < 0) { coordinator_error(f, "process_epoch_queue", false); return PROCESS_INVALID; }
    struct kevent watch;
    EV_SET(&watch, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_EXEC | NOTE_EXIT, 0, NULL);
    if (kevent(queue, &watch, 1, NULL, 0, NULL) < 0) {
        int error = errno; close(queue);
        if (error == ESRCH && !still_alive(pid)) return PROCESS_ABSENT;
        errno = error; coordinator_error(f, "process_epoch_watch", false); return PROCESS_INVALID;
    }
    enum process_observation result = PROCESS_INVALID;
    for (unsigned attempt = 0; attempt < RECOVERY_EPOCH_RETRIES; attempt++) {
        struct proc_bsdinfo before, after; struct coordinator_failure candidate = {0}; uint32_t events;
        if (!epoch_events(queue, &events, f)) break;
        if ((events & NOTE_EXIT) != 0 || !still_alive(pid)) { result = PROCESS_ABSENT; break; }
        if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != sizeof(before)) {
            if (!still_alive(pid)) { result = PROCESS_ABSENT; break; }
            coordinator_error(f, "process_identity_census", false); break;
        }
        if (!same_lifetime(&initial, &before)) { result = PROCESS_ABSENT; break; }
        bool path_ok = executable_path(pid, path, &candidate);
        int image = path_ok ? image_index(path) : -1;
        enum code_observation code = CODE_VALIDATED;
        bool valid = path_ok;
        if (valid && image < 0) valid = recovery_fail(&candidate, "unknown_bundle_process");
        if (valid) valid = socket_clients(r, pid, true, &candidate);
        if (valid && mode == CENSUS_STOPPED) valid = recovery_fail(&candidate, "bundle_not_stopped");
        if (valid) { code = recovery_code_observe(r, (size_t)image, pid, NULL, &candidate); valid = code == CODE_VALIDATED; }
        if (code == CODE_INVALID_INSTALLATION) { *f = candidate; break; }
        bool alive = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, sizeof(after)) == sizeof(after) && after.pbi_status != SZOMB;
        char after_path[PROC_PIDPATHINFO_MAXSIZE]; struct coordinator_failure after_failure = {0};
        bool after_ok = alive && executable_path(pid, after_path, &after_failure);
        if (!epoch_events(queue, &events, f)) break;
        if ((events & NOTE_EXIT) != 0 || !alive || !same_lifetime(&initial, &after)) { result = PROCESS_ABSENT; break; }
        if ((events & NOTE_EXEC) != 0 || (path_ok && after_ok && strcmp(path, after_path) != 0)) {
            if (attempt + 1U == RECOVERY_EPOCH_RETRIES) recovery_fail(f, "process_epoch_bound");
            continue;
        }
        if (!valid) { *f = candidate; break; }
        if (!after_ok) { *f = after_failure; break; }
        if ((strcmp(recovery_images[image].role, "docker_cli") == 0 || strcmp(recovery_images[image].role, "desktop_cli") == 0)
            && mode != CENSUS_OBSERVING) { recovery_fail(f, "lifecycle_cli_live"); break; }
        *out = (struct process_fact){ .pid = pid, .parent = (pid_t)before.pbi_ppid, .group = (pid_t)before.pbi_pgid,
            .uid = before.pbi_uid, .seconds = before.pbi_start_tvsec, .microseconds = before.pbi_start_tvusec, .image = (size_t)image };
        result = PROCESS_VALIDATED; break;
    }
    close(queue); if (result == PROCESS_ABSENT) *f = (struct coordinator_failure){0}; return result;
}
bool recovery_processes(struct recovery *r, struct process_fact *out, size_t *count, enum census_mode mode, struct coordinator_failure *f) {
    enum { MAX_PIDS = 65536 }; pid_t *pids = calloc(MAX_PIDS + 1U, sizeof(pid_t));
    if (!pids) return coordinator_error(f, "process_allocation", false);
    int size = proc_listpids(PROC_UID_ONLY, getuid(), pids, (MAX_PIDS + 1) * (int)sizeof(pid_t));
    if (size <= 0 || size >= (MAX_PIDS + 1) * (int)sizeof(pid_t)) { free(pids); return recovery_fail(f, "process_census_bound"); }
    size_t total = 0; bool ok = true;
    for (size_t i = 0; i < (size_t)size / sizeof(pid_t); i++) {
        pid_t pid = pids[i]; if (pid <= 0) continue;
        struct process_fact process; enum process_observation observed = recovery_process(r, pid, &process, mode, f);
        if (observed == PROCESS_INVALID) { ok = false; break; }
        if (observed != PROCESS_VALIDATED) continue;
        if (strcmp(recovery_images[process.image].role, "docker_cli") == 0 || strcmp(recovery_images[process.image].role, "desktop_cli") == 0) continue;
        if (total == RECOVERY_PROCESS_MAX) { ok = recovery_fail(f, "producer_bound"); break; }
        out[total++] = process;
    }
    free(pids); *count = total; return ok;
}
void recovery_process_json(struct json *j, const struct process_fact *p) {
    json_raw(j, "{\"role\":\"%s\",\"pid\":%d,\"uid\":%u,\"parentPid\":%d,\"processGroup\":%d,\"startSeconds\":\"%llu\",\"startMicroseconds\":\"%llu\",\"pidVersion\":null,\"imageSha256\":\"%s\"}",
        recovery_images[p->image].role, p->pid, p->uid, p->parent, p->group, (unsigned long long)p->seconds, (unsigned long long)p->microseconds, recovery_images[p->image].sha);
}
