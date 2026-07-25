// A compact reduced-state kernel exposed to the browser.
//
// The Web front end consumes only the modal vector q. That is the same data
// boundary used by VegaFEM reduced simulation: the browser supplies the
// production rendering modal matrix and this module assembles u = Uq.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
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
  std::vector<double> linearCoefficients;
  std::vector<double> quadraticCoefficients;
  std::vector<double> cubicCoefficients;
  std::array<double, kModeCount * (kModeCount + 1) / 2> qiqj{};
  int renderingRows = 0;
  int quadraticSize = 0;
  int cubicSize = 0;
  int pulledVertex = -1;
  std::array<double, 3> pullVector{};
  // This is deliberately normalized for the browser's explicit microstep
  // integrator. The native 33605.2 scene value is paired with implicit
  // Newmark; applying it directly here would make a pointer drag unstable.
  double compliance = 100.0;
  double baseFrequency = 0.25;
  double massDamping = 0.0;
  double stiffnessDamping = 0.003;
  bool useLinearModel = false;
  bool staticOnly = false;

  void reset()
  {
    q.fill(0.0);
    qdot.fill(0.0);
    pulledVertex = -1;
    pullVector.fill(0.0);
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

  bool setStVKCubicPolynomial(const unsigned char * data, int byteCount)
  {
    // VegaFEM .cub files are: r, linearSize, quadraticSize, cubicSize, then
    // column-major double coefficient arrays. WebAssembly is little-endian,
    // matching the existing little-endian VegaFEM assets.
    if (data == nullptr || byteCount < 4 * static_cast<int>(sizeof(std::int32_t)))
      return false;

    std::int32_t header[4];
    std::memcpy(header, data, sizeof(header));
    const int modeCount = header[0];
    const int fileLinearSize = header[1];
    const int fileQuadraticSize = header[2];
    const int fileCubicSize = header[3];
    const int expectedQuadraticSize = static_cast<int>(kModeCount * (kModeCount + 1) / 2);
    const int expectedCubicSize = static_cast<int>(kModeCount * (kModeCount + 1) * (kModeCount + 2) / 6);
    if (modeCount != static_cast<int>(kModeCount) || fileLinearSize != modeCount ||
        fileQuadraticSize != expectedQuadraticSize || fileCubicSize != expectedCubicSize)
      return false;

    const std::size_t coefficientCount = static_cast<std::size_t>(modeCount) *
      static_cast<std::size_t>(fileLinearSize + fileQuadraticSize + fileCubicSize);
    const std::size_t expectedBytes = sizeof(header) + coefficientCount * sizeof(double);
    if (expectedBytes != static_cast<std::size_t>(byteCount))
      return false;

    const unsigned char * cursor = data + sizeof(header);
    linearCoefficients.resize(static_cast<std::size_t>(modeCount) * fileLinearSize);
    quadraticCoefficients.resize(static_cast<std::size_t>(modeCount) * fileQuadraticSize);
    cubicCoefficients.resize(static_cast<std::size_t>(modeCount) * fileCubicSize);
    std::memcpy(linearCoefficients.data(), cursor, linearCoefficients.size() * sizeof(double));
    cursor += linearCoefficients.size() * sizeof(double);
    std::memcpy(quadraticCoefficients.data(), cursor, quadraticCoefficients.size() * sizeof(double));
    cursor += quadraticCoefficients.size() * sizeof(double);
    std::memcpy(cubicCoefficients.data(), cursor, cubicCoefficients.size() * sizeof(double));
    quadraticSize = fileQuadraticSize;
    cubicSize = fileCubicSize;
    return true;
  }

  void evaluateStVKInternalForces(const std::array<double, kModeCount> & state,
    std::array<double, kModeCount> & forces, bool includeNonlinear)
  {
    forces.fill(0.0);
    if (linearCoefficients.empty())
      return;

    for (std::size_t output = 0; output < kModeCount; ++output)
      for (std::size_t input = 0; input < kModeCount; ++input)
        forces[output] += linearCoefficients[output * kModeCount + input] * state[input];

    if (!includeNonlinear)
      return;

    std::size_t qiqjIndex = 0;
    for (std::size_t i = 0; i < kModeCount; ++i)
      for (std::size_t j = i; j < kModeCount; ++j)
        qiqj[qiqjIndex++] = state[i] * state[j];

    for (std::size_t output = 0; output < kModeCount; ++output)
      for (int index = 0; index < quadraticSize; ++index)
        forces[output] += quadraticCoefficients[output * quadraticSize + index] * qiqj[static_cast<std::size_t>(index)];

    int qiqjOffset = 0;
    int cubicOffset = 0;
    int size = quadraticSize;
    for (std::size_t i = 0; i < kModeCount; ++i)
    {
      for (std::size_t output = 0; output < kModeCount; ++output)
      {
        double contribution = 0.0;
        const std::size_t coefficientOffset = output * cubicSize + cubicOffset;
        for (int index = 0; index < size; ++index)
          contribution += cubicCoefficients[coefficientOffset + index] * qiqj[static_cast<std::size_t>(qiqjOffset + index)];
        forces[output] += state[i] * contribution;
      }
      const int remaining = static_cast<int>(kModeCount - i);
      size -= remaining;
      qiqjOffset += remaining;
      cubicOffset += remaining * (remaining + 1) / 2;
    }
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
    // The native demo uses implicit Newmark.  This compact browser kernel uses
    // semi-implicit Euler, so it takes sufficiently small microsteps to keep
    // the stiff Bridge polynomial stable while a user pulls on a vertex.
    const int substeps = std::max(1, static_cast<int>(std::ceil(clampedDelta / (1.0 / 1200.0))));
    const double dt = clampedDelta / static_cast<double>(substeps);

    for (int substep = 0; substep < substeps; ++substep)
    {
      if (!linearCoefficients.empty())
      {
        std::array<double, kModeCount> internalForces;
        std::array<double, kModeCount> externalForces{};
        evaluateStVKInternalForces(q, internalForces, !useLinearModel);

        // This is ModalMatrix::ProjectSingleVertex from the native driver:
        // fq = U_vertex^T * (compliance * screen-space pull direction).
        if (pulledVertex >= 0 && 3 * pulledVertex + 2 < renderingRows)
        {
          const int row = 3 * pulledVertex;
          for (std::size_t mode = 0; mode < kModeCount; ++mode)
          {
            const std::size_t offset = static_cast<std::size_t>(row) + mode * renderingRows;
            externalForces[mode] = compliance * (
              static_cast<double>(renderingBasis[offset]) * pullVector[0] +
              static_cast<double>(renderingBasis[offset + 1]) * pullVector[1] +
              static_cast<double>(renderingBasis[offset + 2]) * pullVector[2]);
          }
        }
        for (std::size_t mode = 0; mode < kModeCount; ++mode)
        {
          const double acceleration = externalForces[mode] - baseFrequency * baseFrequency * internalForces[mode] -
            // Native uses implicit Newmark for the K*qdot Rayleigh term.  An
            // explicit version is unstable for this stiff Bridge polynomial,
            // so retain the user-facing coefficient as a stable modal-drag
            // approximation in the portable browser integrator.
            (massDamping + 30.0 * stiffnessDamping) * qdot[mode];
          qdot[mode] += dt * acceleration;
          if (staticOnly)
            qdot[mode] *= 0.08;
          q[mode] += dt * qdot[mode];
        }
      }
      else
      {
        // Safe fallback while the asynchronous browser asset load is pending.
        for (std::size_t mode = 0; mode < kModeCount; ++mode)
        {
          const double frequency = 5.0 + static_cast<double>(mode + 1) * 1.65;
          qdot[mode] += dt * (-frequency * frequency * q[mode]);
          q[mode] += dt * qdot[mode];
        }
      }

      for (std::size_t mode = 0; mode < kModeCount; ++mode)
      {
        if (!std::isfinite(q[mode]) || std::abs(q[mode]) > 20.0)
        {
          reset();
          break;
        }
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
  // Compatibility entry point for older hosts. New hosts use a picked vertex.
  g_simulation.pulledVertex = 0;
  g_simulation.pullVector = {{std::max(-30.0, std::min(normalizedForce, 30.0)), 0.0, 0.0}};
}

void vegafem_web_set_pull(void *, int vertex, double x, double y, double z)
{
  g_simulation.pulledVertex = vertex;
  g_simulation.pullVector = {{x, y, z}};
}

void vegafem_web_clear_pull(void *)
{
  g_simulation.pulledVertex = -1;
  g_simulation.pullVector.fill(0.0);
}

void vegafem_web_set_parameter(void *, int parameter, double value)
{
  switch (parameter)
  {
    case 0: g_simulation.compliance = std::max(0.0, std::min(value, 2000.0)); break;
    case 1: g_simulation.baseFrequency = std::max(0.0, std::min(value, 2.0)); break;
    case 2: g_simulation.massDamping = std::max(0.0, std::min(value, 10.0)); break;
    case 3: g_simulation.stiffnessDamping = std::max(0.0, std::min(value, 0.1)); break;
    case 4: g_simulation.useLinearModel = value != 0.0; break;
    case 5: g_simulation.staticOnly = value != 0.0; break;
  }
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

int vegafem_web_set_stvk_cubic_polynomial(void *, const unsigned char * data, int byteCount)
{
  return g_simulation.setStVKCubicPolynomial(data, byteCount) ? 0 : 1;
}

const float * vegafem_web_deformed_positions(void *)
{
  return g_simulation.assembleRenderingDisplacements();
}
}
