/**
 * Distribute N points evenly on a sphere surface using Fibonacci spiral.
 * Returns array of [x, y, z] positions.
 */
export function fibonacciSphere(count, radius = 1) {
  const points = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))

  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2 // -1 to 1
    const radiusAtY = Math.sqrt(1 - y * y)
    const theta = goldenAngle * i

    points.push([
      Math.cos(theta) * radiusAtY * radius,
      y * radius,
      Math.sin(theta) * radiusAtY * radius,
    ])
  }
  return points
}

/**
 * Role-clustered distribution: orchestrators near centre,
 * managers on equatorial band, specialists upper hemisphere,
 * plugin agents lower hemisphere.
 */
export function clusteredAgentPositions(agents, innerRadius = 12, outerRadius = 18) {
  const roles = { orchestrator: [], manager: [], specialist: [], analyst: [], plugin: [] }

  agents.forEach(a => {
    const role = a.ownership?.source === 'plugin' ? 'plugin' : (a.role || 'specialist')
    const bucket = roles[role] || roles.specialist
    bucket.push(a)
  })

  const positions = new Map()

  // Orchestrator: near nucleus
  roles.orchestrator.forEach((a, i) => {
    positions.set(a.id, [0, 2, 0])
  })

  // Managers: equatorial band at inner radius
  const managerCount = roles.manager.length + roles.analyst.length
  const managers = [...roles.manager, ...roles.analyst]
  managers.forEach((a, i) => {
    const angle = (i / Math.max(managerCount, 1)) * Math.PI * 2
    positions.set(a.id, [
      Math.cos(angle) * innerRadius,
      (Math.random() - 0.5) * 3,
      Math.sin(angle) * innerRadius,
    ])
  })

  // Specialists: upper hemisphere
  const specPoints = fibonacciSphere(roles.specialist.length, (innerRadius + outerRadius) / 2)
  roles.specialist.forEach((a, i) => {
    const p = specPoints[i] || [0, 0, outerRadius]
    // Bias toward upper hemisphere
    positions.set(a.id, [p[0], Math.abs(p[1]) * 0.8 + 1, p[2]])
  })

  // Plugin agents: lower hemisphere cluster
  roles.plugin.forEach((a, i) => {
    const angle = (i / Math.max(roles.plugin.length, 1)) * Math.PI * 2
    positions.set(a.id, [
      Math.cos(angle) * outerRadius,
      -3 - Math.random() * 3,
      Math.sin(angle) * outerRadius,
    ])
  })

  return positions
}
