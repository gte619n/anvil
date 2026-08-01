/** A client command that can't be honored (bad args, no such session). → command.error.
 *  Lives in its own module so both the Supervisor and the domain services it delegates to
 *  (e.g. IntegrationsFacade) can throw it without a circular import through supervisor.ts. */
export class BadCommand extends Error {}
