"use client";

// FR-10, BR-5: React Three Fiber diamond scene.
// Renders a parametric diamond geometry (lathe of a brilliant cross-section)
// with a physically-based refractive material and an orbit-controlled camera.
//
// This component is always loaded lazily (dynamic import) so Three.js never
// enters the SSR bundle.

import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

// ── Diamond geometry ──────────────────────────────────────────────────────────
//
// A round-brilliant diamond has two main parts:
//   Crown  — the top portion above the girdle
//   Pavilion — the bottom portion below the girdle
//
// We build a lathe geometry by defining 2D profile points
// (radius, y) from table → girdle → culet, then revolving around Y.

function buildDiamondProfile(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];

  // Table (flat top, radius ≈ 55% of girdle)
  const girdle = 1.0;
  const tableR = 0.53;
  const crownH = 0.32;
  const pavilionH = 0.68;
  const culetR = 0.02;

  // Table edge → outer crown (girdle) with slight step for the crown facet break
  pts.push(new THREE.Vector2(tableR, crownH));
  pts.push(new THREE.Vector2(tableR * 1.05, crownH * 0.85)); // upper crown facets
  pts.push(new THREE.Vector2(girdle, 0));                     // girdle edge

  // Girdle → pavilion → culet
  pts.push(new THREE.Vector2(girdle * 0.97, -0.04));          // upper girdle
  pts.push(new THREE.Vector2(girdle * 0.7, -pavilionH * 0.5));
  pts.push(new THREE.Vector2(girdle * 0.3, -pavilionH * 0.85));
  pts.push(new THREE.Vector2(culetR, -pavilionH));             // culet tip

  return pts;
}

function DiamondMesh({ color }: { color: string }) {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    const profile = buildDiamondProfile();
    return new THREE.LatheGeometry(profile, 32);
  }, []);

  // Map GIA color letter → approximate body tint for the gem material.
  // D–F: nearly colorless (faint warm white), G–J: slight yellow, K+: visible yellow.
  const tintColor = useMemo(() => {
    const idx = "DEFGHIJKLMNOPQRSTUVWXYZ".indexOf(color?.toUpperCase() ?? "G");
    if (idx < 0) return new THREE.Color(0xf8f4ee);
    if (idx <= 2)  return new THREE.Color(0xfdfcfa); // D–F: near-colorless
    if (idx <= 5)  return new THREE.Color(0xfdf8ef); // G–J
    if (idx <= 9)  return new THREE.Color(0xfbf0d4); // K–N
    return new THREE.Color(0xf5e6a0);                // O+
  }, [color]);

  // Gentle auto-rotation so buyer can see all facets before touching controls.
  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.35;
    }
  });

  return (
    <mesh ref={meshRef} geometry={geometry} castShadow>
      <meshPhysicalMaterial
        color={tintColor}
        transmission={0.92}
        thickness={1.4}
        roughness={0.0}
        metalness={0.0}
        ior={2.42}              // diamond refractive index
        reflectivity={1.0}
        clearcoat={1.0}
        clearcoatRoughness={0.0}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ── Scene ─────────────────────────────────────────────────────────────────────

interface DiamondSceneProps {
  color: string;
  onContextLost?: () => void;
}

export default function DiamondScene({ color, onContextLost }: DiamondSceneProps) {
  return (
    <Canvas
      camera={{ position: [0, 0.5, 3.2], fov: 38 }}
      shadows
      gl={{ antialias: true, powerPreference: "default" }}
      style={{ background: "transparent" }}
      aria-hidden="true"  // screen readers use the specs fallback, not the canvas
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          onContextLost?.();
        });
      }}
    >
      {/* Neutral studio lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 5, 2]} intensity={1.2} castShadow />
      <directionalLight position={[-3, 3, -2]} intensity={0.6} />
      <pointLight position={[0, 4, 0]} intensity={0.8} />

      <DiamondMesh color={color} />

      <OrbitControls
        enablePan={false}
        minDistance={1.8}
        maxDistance={6}
        autoRotate={false}
        dampingFactor={0.08}
        enableDamping
      />
    </Canvas>
  );
}
