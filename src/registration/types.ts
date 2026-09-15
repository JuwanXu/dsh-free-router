export interface ManagedRouteClaim {
  sourceRoute: string
  targetRoute: string
  profileSignature: string
  modelIds: string[]
}

export interface ManagedRoutePlan {
  targetRoute: string
  profile: Record<string, unknown>
  claim: ManagedRouteClaim
}

export interface ManagedRouteRegistration {
  route: string
  displayName: string
}
