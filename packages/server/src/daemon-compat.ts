// The wire protocol is the compatibility contract between server and host
// (spec/11 § Deployment: "server and host versions are independent. The wire
// protocol is the compatibility contract: the server states the host version
// range it supports, and a host outside that range is shown as needing an
// update").
//
// Without this, a machine running a host too old to speak the current wire
// shape simply misbehaved — decoding frames it did not understand, or omitting
// fields a surface then rendered as absent. Stating the range turns that into a
// visible "this machine needs updating".
//
// The comparison itself lives in version-report.ts; this module holds only the
// range and the verdict so there is ONE version comparator in the server.

/**
 * The oldest host build this server can speak to. Raise it in the SAME change
 * that makes a wire frame's new shape mandatory rather than additive — that is
 * the moment older hosts stop being able to hold up their end.
 */
export const MIN_SUPPORTED_DAEMON_VERSION = '0.1.375';

export type DaemonSupport =
  | { supported: true }
  | { supported: false; reason: string; remedy: string };
