// A compact reduced-state kernel exposed to the browser.
//
// The Web front end consumes only the modal vector q. That is the same data
// boundary used by VegaFEM reduced simulation: the browser supplies the
// production rendering modal matrix and this module assembles u = Uq.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace
{
constexpr std::size_t kModeCount = 20;

struct ReducedSimulation
{
  std::array<double, kModeCount> q{};
  std::array<double, kModeCount> qdot{};
  std::vector<float> renderingBasis;
  std::vector<float> deformedPositions;
  int renderingRows = 0;
  double externalForce = 0.0;

  void reset()
  {
    q.fill(0.0);
    qdot.fill(0.0);
    externalForce = 0.0;
  }

  bool setModalBasis(const float * basis, int rows, int modes)
  {
    if (basis == nullptr || rows <= 0 || modes != static_cast<int>(kModeCount) || rows % 3 != 0)
      return false;

    renderingRows = rows;
    renderingBasis.assign(basis, basis + static_cast<std::size_t>(rows) * kModeCount);
    deformedPositions.assign(static_cast<std::size_t>(rows), 0.0f);
    return true;
  }

  const float * assembleRenderingDisplacements()
  {
    if (renderingBasis.empty())
      return nullptr;

    // VegaFEM matrices are column-major: U[row + mode * rows]. This is the
    // same U*q operation used by ModalMatrix::AssembleVector in the native
    // reduced demo, but produces float displacements for the browser mesh.
    for (int row = 0; row < renderingRows; ++row)
    {
      double displacement = 0.0;
      for (std::size_t mode = 0; mode < kModeCount; ++mode)
        displacement += static_cast<double>(renderingBasis[row + mode * renderingRows]) * q[mode];
      deformedPositions[static_cast<std::size_t>(row)] = static_cast<float>(displacement);
    }
    return deformedPositions.data();
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

int vegafem_web_set_modal_basis(void *, const float * basis, int rows, int modes)
{
  return g_simulation.setModalBasis(basis, rows, modes) ? 0 : 1;
}

const float * vegafem_web_deformed_positions(void *)
{
  return g_simulation.assembleRenderingDisplacements();
}
}
