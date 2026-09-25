import Darwin

@inline(never)
func crashFixtureAbort() -> Never {
  abort()
}
