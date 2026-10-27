#ifndef AGENAI_DESKTOP_HOST_OBSERVER_H
#define AGENAI_DESKTOP_HOST_OBSERVER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <net/if.h>

#define HOST_OBSERVER_BYTES (4U * 1024U * 1024U)
#define HOST_OBSERVER_INTERFACES 256U
#define HOST_OBSERVER_ADDRESSES 4096U
#define HOST_OBSERVER_ROUTES 4096U

struct host_ip {
    int family;
    uint8_t bytes[16];
    uint32_t scope;
    bool present;
};

struct host_interface {
    uint32_t index;
    uint32_t flags;
    char name[IFNAMSIZ];
};

struct host_address {
    uint32_t index;
    uint32_t flags;
    struct host_ip address;
    struct host_ip mask;
    struct host_ip peer;
    struct host_ip broadcast;
};

struct host_route {
    uint32_t index;
    uint32_t flags;
    uint32_t parent_flags;
    struct host_ip destination;
    struct host_ip mask;
    struct host_ip gateway;
    uint32_t link_gateway;
};

struct host_census {
    struct host_interface interfaces[HOST_OBSERVER_INTERFACES];
    struct host_address addresses[HOST_OBSERVER_ADDRESSES];
    struct host_route routes[HOST_OBSERVER_ROUTES];
    size_t interface_count;
    size_t address_count;
    size_t route_count;
};

struct host_proxy {
    uint32_t reasons;
    size_t scopes;
    size_t entries;
    size_t string_bytes;
    bool unsafe;
    bool unknown;
};

#endif
