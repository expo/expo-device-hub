/** Tiny className joiner — stands in for the website's `mergeClasses`. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
