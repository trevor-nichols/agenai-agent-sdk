// Closed controller-only filesystem protocol; integers on the wire are network byte order.
#ifndef AGENAI_FILESYSTEM_PROTOCOL_H
#define AGENAI_FILESYSTEM_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <signal.h>

#define FILESYSTEM_PROTOCOL "agenai.sandbox.filesystem.v1"
#define FILESYSTEM_LAYOUT "agenai.sandbox.workspace.v1"
#define PATH_BYTES 4079
#define COMPONENTS 128
#define CHUNK_BYTES 65536
#define METADATA_BYTES 2048
#define MAX_SAFE_INTEGER UINT64_C(9007199254740991)

enum operation { OP_STAT = 1, OP_READ, OP_LIST, OP_NEXT, OP_WRITE, OP_APPEND, OP_COMMIT, OP_CANCEL, OP_CLOSE, OP_HEARTBEAT };
enum reply_kind { REPLY_BYTES = 1, REPLY_ENTRY, REPLY_TERMINAL, REPLY_READY, REPLY_HEARTBEAT };
extern volatile sig_atomic_t stopping;

int transport_initialize(int lease_ms);
int transport_read(void *bytes, size_t size);
int transport_frame(uint32_t kind, const void *bytes, size_t size);
void transport_renew(void);
bool transport_failed(void);
void terminal(const char *status, const char *effect, int error, uint64_t count, int mode, const char *metadata);

#endif
