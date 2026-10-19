import "aria-query";

declare module "aria-query" {
  interface ARIARoleDefinition {
    /**
     * WAI-ARIA's "Accessible Name Required". aria-query gives it for every role; its DefinitelyTyped
     * types (`@types/aria-query` 5.0.4) leave it out.
     */
    accessibleNameRequired: boolean;
  }
}
