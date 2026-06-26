# Gyroscope

Interactive 3D **spinning top** (totem-style) with physically correct dynamics.

## Physics

The model is a **heavy symmetric top** with a fixed tip (point contact on the table):

- **ψ** — precession about the vertical
- **θ** — tilt from vertical
- **φ** — spin about the symmetry axis

Kinetic energy: T = ½ I₁(θ̇² + sin²θ ψ̇²) + ½ I₃(φ̇ + ψ̇ cos θ)²

Potential: V = m g ℓ cos θ

These are the standard Lagrange equations from classical mechanics (Goldstein). Precession, nutation, and spin-down all emerge naturally. Faster spin → larger |L| → slower precession (Ω ≈ |τ|/|L|).

## Run

```bash
npm install
npm run dev
```

## Controls

- **Left-drag** on the top — tilt and push (apply torque)
- **Scroll** (while hovering) — spin up or slow down
- **Right-drag** — orbit camera
- **Gravity toggle** — enable/disable gravitational torque
- **Show vectors** — angular momentum (cyan), torque (red), spin axis (silver)
