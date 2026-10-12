/**
 * useDisposable — Automatically dispose Three.js geometry/materials on unmount.
 *
 * Phase CC-14: Memory leak prevention.
 * Wraps useMemo + useEffect cleanup for Three.js objects.
 *
 * Usage:
 *   const geometry = useDisposable(() => new THREE.BufferGeometry(), [deps])
 */
import { useMemo, useEffect, useRef } from 'react'

/**
 * Creates a Three.js object with automatic disposal on unmount or dependency change.
 * @param {Function} factory - Function returning a Three.js object with .dispose()
 * @param {Array} deps - Dependency array (same as useMemo)
 * @returns {Object} The created Three.js object
 */
export function useDisposable(factory, deps) {
  const ref = useRef(null)

  const obj = useMemo(() => {
    // Dispose previous on re-creation
    if (ref.current && typeof ref.current.dispose === 'function') {
      ref.current.dispose()
    }
    const newObj = factory()
    ref.current = newObj
    return newObj
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  // Dispose on unmount
  useEffect(() => {
    return () => {
      if (ref.current && typeof ref.current.dispose === 'function') {
        ref.current.dispose()
        ref.current = null
      }
    }
  }, [])

  return obj
}

/**
 * Traverse a Three.js group/scene and dispose all geometry + materials.
 * Useful for cleanup in useEffect return.
 * @param {THREE.Object3D} obj
 */
export function disposeTree(obj) {
  if (!obj) return
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose()
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose())
      } else {
        child.material.dispose()
      }
    }
  })
}
