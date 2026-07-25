// A compact, allocation-free reduced-state kernel exposed to the browser.
//
// The Web front end consumes only the modal vector q. That is the same data
// boundary used by VegaFEM reduced simulation: future loaders can replace the
// analytical demo modes with a model-specific U matrix without changing the
// JavaScript rendering or input contract.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>

namespace
{
constexpr std::size_t kModeCount = 20;

struct ReducedSimulation
{
  std::array<double, kModeCount> q{};
  std::array<double, kModeCount> qdot{};
  double externalForce = 0.0;

  void reset()
  {
    q.fill(0.0);
    qdot.fill(0.0);
    externalForce = 0.0;
  }

  void step(double frameDeltaSeconds)
  {
    // Bound work per browser frame. Larger gaps (for example after a mobile
    // tab resumes) are integrated in fixed microsteps instead of destabilizing
    // the reduced state in one large Euler step.
    const double clampedDelta = std::max(0.0, std::min(frameDeltaSeconds, 0.05));
    const int substeps = std::max(1, static_cast<int>(std::ceil(clampedDelta / (1.0 / 120.0))));
    const double dt = clampedDelta / static_cast<double>(substeps);

    for (int substep = 0; substep < substeps; ++substep)
    {
      for (std::size_t mode = 0; mode < kModeCount; ++mode)
      {
        const double modeNumber = static_cast<double>(mode + 1);
        const double angularFrequency = 5.0 + modeNumber * 1.65;
        const double damping = 0.32 + modeNumber * 0.018;
        const double neighboringDisplacement =
          (mode > 0 ? q[mode - 1] : 0.0) +
          (mode + 1 < kModeCount ? q[mode + 1] : 0.0);
        const double modalForce = externalForce * std::exp(-0.17 * modeNumber);
        const double acceleration =
          modalForce + 0.20 * neighboringDisplacement -
          damping * qdot[mode] -
          angularFrequency * angularFrequency * q[mode];

        // Semi-implicit Euler is stable enough for this low-order visual
        // preview and preserves the fixed-size, SIMD-friendly data layout.
        qdot[mode] += dt * acceleration;
        q[mode] += dt * qdot[mode];
      }
    }
  }
};

ReducedSimulation g_simulation;
}

extern "C"
{
void * vegafem_web_create()
{
  g_simulation.reset();
  return &g_simulation;
}

void vegafem_web_reset(void *)
{
  g_simulation.reset();
}

void vegafem_web_step(void *, double frameDeltaSeconds)
{
  g_simulation.step(frameDeltaSeconds);
}

void vegafem_web_set_force(void *, double normalizedForce)
{
  // Prevent accidental huge impulses from pointer-coordinate glitches.
  g_simulation.externalForce = std::max(-30.0, std::min(normalizedForce, 30.0));
}

const double * vegafem_web_modal_state(void *)
{
  return g_simulation.q.data();
}

int vegafem_web_mode_count()
{
  return static_cast<int>(kModeCount);
}
}
