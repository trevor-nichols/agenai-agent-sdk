#ifndef AGENAI_DESKTOP_COORDINATOR_H
#define AGENAI_DESKTOP_COORDINATOR_H

#include <stdbool.h>
#include <stddef.h>
#include <sys/stat.h>

#define COORDINATOR_MAX_FRAME 1048576U
#define COORDINATOR_FRAME_HEADER 148U
#define COORDINATOR_MAX_PAYLOAD (COORDINATOR_MAX_FRAME - COORDINATOR_FRAME_HEADER)

enum coordinator_mode { MODE_INITIALIZE, MODE_OPEN, MODE_CLEANUP };

struct coordinator {
    int root_fd;
    int lock_fd;
    int state_fd;
    int temp_fd;
    struct stat root_identity;
    struct stat lock_identity;
    struct stat state_identity;
    struct stat temp_identity;
    char home[4096];
    char key[65];
    char lock_name[70];
    char state_name[71];
    char temp_name[70];
    char state_digest[65];
    bool claimed;
    bool initial_required;
    bool temp_present;
    bool fenced;
    bool cleanup;
    bool has_state_digest;
};

struct coordinator_failure { const char *reason; int error; bool lost; };

bool coordinator_private_file(const struct stat *value);
bool coordinator_same(const struct stat *left, const struct stat *right);
bool coordinator_error(struct coordinator_failure *failure, const char *reason, bool lost);
bool coordinator_conflict(struct coordinator_failure *failure, const char *reason);
bool coordinator_open(struct coordinator *owner, enum coordinator_mode mode, struct coordinator_failure *failure);
bool coordinator_check(struct coordinator *owner, struct coordinator_failure *failure);
bool coordinator_read(struct coordinator *owner, char **payload, size_t *length, char digest[65], struct coordinator_failure *failure);
bool coordinator_commit(struct coordinator *owner, const char *payload, size_t length, char digest[65], struct coordinator_failure *failure);
bool coordinator_discard_temp(struct coordinator *owner, struct coordinator_failure *failure);
void coordinator_close(struct coordinator *owner);
bool coordinator_utf8(const unsigned char *bytes, size_t length);

#endif
