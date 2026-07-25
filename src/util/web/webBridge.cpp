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
  std::array<double, kModeCount> qvel{};
  std::array<double, kModeCount> qaccel{};
  std::vector<float> renderingBasis;
  std::vector<float> deformedPositions;
  std::vector<double> linearCoefficients;
  std::vector<double> quadraticCoefficients;
  std::vector<double> cubicCoefficients;
  int renderingRows = 0;
  int quadraticSize = 0;
  int cubicSize = 0;
  int pulledVertex = -1;
  std::array<double, 3> pullVector{};
  // Values below match realtime/simpleBridge/simpleBridge.config.
  double compliance = 33605.2;
  double baseFrequency = 0.25;
  double massDamping = 0.0;
  double stiffnessDamping = 0.003;
  bool useLinearModel = false;
  bool staticOnly = false;

  void reset()
  {
    q.fill(0.0);
    qvel.fill(0.0);
    qaccel.fill(0.0);
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

  void evaluateStVKForceAndTangent(const std::array<double, kModeCount> & state,
    std::array<double, kModeCount> & forces,
    std::array<double, kModeCount * kModeCount> & tangent, bool includeNonlinear)
  {
    forces.fill(0.0);
    tangent.fill(0.0);
    if (linearCoefficients.empty())
      return;

    for (std::size_t output = 0; output < kModeCount; ++output)
      for (std::size_t input = 0; input < kModeCount; ++input)
      {
        forces[output] += linearCoefficients[output * kModeCount + input] * state[input];
        tangent[output * kModeCount + input] += linearCoefficients[output * kModeCount + input];
      }

    if (!includeNonlinear)
      return;

    int quadraticIndex = 0;
    for (std::size_t i = 0; i < kModeCount; ++i)
      for (std::size_t j = i; j < kModeCount; ++j)
      {
        for (std::size_t output = 0; output < kModeCount; ++output)
        {
          const double coefficient = quadraticCoefficients[output * quadraticSize + quadraticIndex];
          forces[output] += coefficient * state[i] * state[j];
          tangent[output * kModeCount + i] += coefficient * state[j];
          tangent[output * kModeCount + j] += coefficient * state[i];
        }
        ++quadraticIndex;
      }

    int cubicIndex = 0;
    for (std::size_t i = 0; i < kModeCount; ++i)
      for (std::size_t j = i; j < kModeCount; ++j)
        for (std::size_t k = j; k < kModeCount; ++k)
        {
          for (std::size_t output = 0; output < kModeCount; ++output)
          {
            const double coefficient = cubicCoefficients[output * cubicSize + cubicIndex];
            forces[output] += coefficient * state[i] * state[j] * state[k];
            tangent[output * kModeCount + i] += coefficient * state[j] * state[k];
            tangent[output * kModeCount + j] += coefficient * state[i] * state[k];
            tangent[output * kModeCount + k] += coefficient * state[i] * state[j];
          }
          ++cubicIndex;
        }
  }

  bool solveDenseSystem(std::array<double, kModeCount * kModeCount> matrix,
    std::array<double, kModeCount> & rightHandSide)
  {
    // The native implementation calls LAPACK DPOSV on this 20x20 effective
    // Newmark matrix. Partial-pivot Gaussian elimination gives the same dense
    // solve here without making the Safari Wasm baseline depend on LAPACK.
    for (std::size_t column = 0; column < kModeCount; ++column)
    {
      std::size_t pivot = column;
      for (std::size_t row = column + 1; row < kModeCount; ++row)
        if (std::abs(matrix[row * kModeCount + column]) > std::abs(matrix[pivot * kModeCount + column]))
          pivot = row;
      if (std::abs(matrix[pivot * kModeCount + column]) < 1e-12)
        return false;
      if (pivot != column)
      {
        for (std::size_t entry = column; entry < kModeCount; ++entry)
          std::swap(matrix[column * kModeCount + entry], matrix[pivot * kModeCount + entry]);
        std::swap(rightHandSide[column], rightHandSide[pivot]);
      }
      for (std::size_t row = column + 1; row < kModeCount; ++row)
      {
        const double factor = matrix[row * kModeCount + column] / matrix[column * kModeCount + column];
        for (std::size_t entry = column + 1; entry < kModeCount; ++entry)
          matrix[row * kModeCount + entry] -= factor * matrix[column * kModeCount + entry];
        rightHandSide[row] -= factor * rightHandSide[column];
      }
    }
    for (int row = static_cast<int>(kModeCount) - 1; row >= 0; --row)
    {
      double sum = rightHandSide[static_cast<std::size_t>(row)];
      for (std::size_t column = static_cast<std::size_t>(row) + 1; column < kModeCount; ++column)
        sum -= matrix[static_cast<std::size_t>(row) * kModeCount + column] * rightHandSide[column];
      rightHandSide[static_cast<std::size_t>(row)] = sum / matrix[static_cast<std::size_t>(row) * kModeCount + static_cast<std::size_t>(row)];
    }
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
    // Match the native idle routine: one graphics-frame timestep divided into
    // the five simpleBridge.config substeps, using beta=.25 and gamma=.5.
    const double clampedDelta = std::max(0.0, std::min(frameDeltaSeconds, 0.05));
    const int substeps = 5;
    const double dt = clampedDelta / static_cast<double>(substeps);
    if (dt == 0.0 || linearCoefficients.empty())
      return;

    for (int substep = 0; substep < substeps; ++substep)
    {
      std::array<double, kModeCount> externalForces{};
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

      const std::array<double, kModeCount> qPrevious = q;
      const std::array<double, kModeCount> qvelPrevious = qvel;
      const std::array<double, kModeCount> qaccelPrevious = qaccel;
      const double beta = 0.25;
      const double gamma = 0.5;
      const double alpha1 = 1.0 / (beta * dt * dt);
      const double alpha2 = 1.0 / (beta * dt);
      const double alpha3 = (1.0 - 2.0 * beta) / (2.0 * beta);
      const double alpha4 = gamma / (beta * dt);
      const double alpha5 = 1.0 - gamma / beta;
      const double alpha6 = (1.0 - gamma / (2.0 * beta)) * dt;

      // This is the initial guess and first (the native default is one)
      // Newton iteration from ImplicitNewmarkDense::DoTimestep.
      for (std::size_t mode = 0; mode < kModeCount; ++mode)
      {
        qaccel[mode] = -alpha2 * qvelPrevious[mode] - alpha3 * qaccelPrevious[mode];
        qvel[mode] = alpha5 * qvelPrevious[mode] + alpha6 * qaccelPrevious[mode];
      }

      std::array<double, kModeCount> internalForces;
      std::array<double, kModeCount * kModeCount> tangent;
      evaluateStVKForceAndTangent(q, internalForces, tangent, !useLinearModel);
      const double internalScale = baseFrequency * baseFrequency;
      for (std::size_t entry = 0; entry < tangent.size(); ++entry)
        tangent[entry] *= internalScale;
      for (std::size_t mode = 0; mode < kModeCount; ++mode)
        internalForces[mode] *= internalScale;

      std::array<double, kModeCount * kModeCount> effectiveStiffness = tangent;
      std::array<double, kModeCount> residual{};
      for (std::size_t row = 0; row < kModeCount; ++row)
      {
        double dampingVelocity = 0.0;
        for (std::size_t column = 0; column < kModeCount; ++column)
        {
          const double damping = (row == column ? massDamping : 0.0) + stiffnessDamping * tangent[row * kModeCount + column];
          effectiveStiffness[row * kModeCount + column] += alpha4 * damping + (row == column ? alpha1 : 0.0);
          dampingVelocity += damping * qvel[column];
        }
        residual[row] = -(qaccel[row] + dampingVelocity + internalForces[row] - externalForces[row]);
      }

      if (staticOnly)
      {
        effectiveStiffness = tangent;
        for (std::size_t mode = 0; mode < kModeCount; ++mode)
          residual[mode] = externalForces[mode] - internalForces[mode];
      }

      if (!solveDenseSystem(effectiveStiffness, residual))
      {
        reset();
        break;
      }
      for (std::size_t mode = 0; mode < kModeCount; ++mode)
      {
        q[mode] += residual[mode];
        qaccel[mode] = alpha1 * (q[mode] - qPrevious[mode]) - alpha2 * qvelPrevious[mode] - alpha3 * qaccelPrevious[mode];
        qvel[mode] = alpha4 * (q[mode] - qPrevious[mode]) + alpha5 * qvelPrevious[mode] + alpha6 * qaccelPrevious[mode];
        if (!std::isfinite(q[mode]) || !std::isfinite(qvel[mode]) || std::abs(q[mode]) > 1e6)
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
    case 0: g_simulation.compliance = std::max(0.0, std::min(value, 100000.0)); break;
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
