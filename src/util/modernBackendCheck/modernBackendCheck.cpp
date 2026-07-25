// SPDX-License-Identifier: BSD-3-Clause
//
// A deliberately small, headless validation target for the modern backend.
// It exercises the same compiler/linker/runtime boundary that the full
// simulator will use: SDL2 for platform integration, Vulkan for rendering,
// and SYCL for Intel CPU/GPU compute.  Keeping this check headless makes it
// suitable for hosted CI, where no physical Intel GPU is guaranteed.

#include <SDL.h>
#include <vulkan/vulkan.h>
#include <sycl/sycl.hpp>
#include <CL/cl.h>

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

void checkVk(VkResult result, const char *operation)
{
  if (result != VK_SUCCESS)
    throw std::runtime_error(std::string(operation) + " failed with VkResult " +
                             std::to_string(static_cast<int>(result)));
}

void checkSycl()
{
  const auto devices = sycl::device::get_devices();
  if (devices.empty())
    throw std::runtime_error("SYCL runtime reported no devices");

  std::cout << "SYCL devices: " << devices.size() << '\n';
  for (const auto &device : devices)
  {
    std::cout << "  - " << device.get_info<sycl::info::device::name>()
              << " ("
              << (device.is_gpu() ? "GPU" : device.is_cpu() ? "CPU" : "other")
              << ")\n";
  }

  // The default selector lets hosted CI use the Intel CPU device while an
  // Intel GPU runner naturally selects its GPU.  The production simulator
  // will expose an explicit device-selection policy.
  sycl::queue queue{sycl::default_selector_v};
  constexpr std::size_t count = 256;
  std::vector<int> values(count, 0);
  {
    sycl::buffer<int> buffer(values.data(), sycl::range<1>(count));
    queue.submit([&](sycl::handler &handler) {
      auto data = buffer.get_access<sycl::access::mode::write>(handler);
      handler.parallel_for(sycl::range<1>(count), [=](sycl::id<1> id) {
        data[id] = static_cast<int>(id[0] * 3 + 1);
      });
    });
    queue.wait_and_throw();
  }
  for (std::size_t i = 0; i < count; ++i)
    if (values[i] != static_cast<int>(i * 3 + 1))
      throw std::runtime_error("SYCL validation kernel returned incorrect data");

  std::cout << "SYCL validation device: "
            << queue.get_device().get_info<sycl::info::device::name>() << '\n';
}

bool checkOpenCL()
{
  cl_uint platformCount = 0;
  if (clGetPlatformIDs(0, nullptr, &platformCount) != CL_SUCCESS ||
      platformCount == 0)
    return false;

  std::vector<cl_platform_id> platforms(platformCount);
  if (clGetPlatformIDs(platformCount, platforms.data(), nullptr) != CL_SUCCESS)
    return false;

  bool foundDevice = false;
  for (cl_platform_id platform : platforms)
  {
    size_t nameSize = 0;
    clGetPlatformInfo(platform, CL_PLATFORM_NAME, 0, nullptr, &nameSize);
    std::string name(nameSize, '\0');
    if (nameSize != 0)
      clGetPlatformInfo(platform, CL_PLATFORM_NAME, nameSize, name.data(), nullptr);
    if (!name.empty() && name.back() == '\0')
      name.pop_back();

    cl_uint deviceCount = 0;
    const cl_int result = clGetDeviceIDs(platform, CL_DEVICE_TYPE_ALL, 0, nullptr,
                                         &deviceCount);
    if (result != CL_SUCCESS || deviceCount == 0)
      continue;

    std::cout << "OpenCL platform: " << name << " (" << deviceCount
              << " device(s))\n";
    foundDevice = true;
  }
  return foundDevice;
}

void checkVulkan()
{
  uint32_t extensionCount = 0;
  checkVk(vkEnumerateInstanceExtensionProperties(nullptr, &extensionCount, nullptr),
          "vkEnumerateInstanceExtensionProperties");

  VkApplicationInfo applicationInfo{VK_STRUCTURE_TYPE_APPLICATION_INFO};
  applicationInfo.pApplicationName = "VegaFEM modern backend check";
  applicationInfo.applicationVersion = VK_MAKE_VERSION(1, 0, 0);
  applicationInfo.pEngineName = "VegaFEM";
  applicationInfo.engineVersion = VK_MAKE_VERSION(1, 0, 0);
  applicationInfo.apiVersion = VK_API_VERSION_1_2;

  VkInstanceCreateInfo instanceInfo{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
  instanceInfo.pApplicationInfo = &applicationInfo;
  VkInstance instance = VK_NULL_HANDLE;
  checkVk(vkCreateInstance(&instanceInfo, nullptr, &instance), "vkCreateInstance");

  uint32_t deviceCount = 0;
  checkVk(vkEnumeratePhysicalDevices(instance, &deviceCount, nullptr),
          "vkEnumeratePhysicalDevices(count)");
  if (deviceCount == 0)
  {
    vkDestroyInstance(instance, nullptr);
    throw std::runtime_error("Vulkan runtime reported no physical devices");
  }

  std::vector<VkPhysicalDevice> devices(deviceCount);
  checkVk(vkEnumeratePhysicalDevices(instance, &deviceCount, devices.data()),
          "vkEnumeratePhysicalDevices");
  std::cout << "Vulkan physical devices: " << deviceCount << '\n';
  for (VkPhysicalDevice device : devices)
  {
    VkPhysicalDeviceProperties properties{};
    vkGetPhysicalDeviceProperties(device, &properties);
    std::cout << "  - " << properties.deviceName << " (Vulkan "
              << VK_VERSION_MAJOR(properties.apiVersion) << '.'
              << VK_VERSION_MINOR(properties.apiVersion) << '.'
              << VK_VERSION_PATCH(properties.apiVersion) << ")\n";
  }

  vkDestroyInstance(instance, nullptr);
}

} // namespace

int main()
{
  if (SDL_Init(0) != 0)
  {
    std::cerr << "SDL initialization failed: " << SDL_GetError() << '\n';
    return EXIT_FAILURE;
  }

  try
  {
    SDL_version version{};
    SDL_GetVersion(&version);
    std::cout << "SDL2: " << static_cast<int>(version.major) << '.'
              << static_cast<int>(version.minor) << '.'
              << static_cast<int>(version.patch) << '\n';
    checkVulkan();
    bool syclAvailable = false;
    try
    {
      checkSycl();
      syclAvailable = true;
    }
    catch (const std::exception &error)
    {
      std::cerr << "SYCL unavailable: " << error.what() << '\n';
    }
    const bool openclAvailable = checkOpenCL();
    if (!syclAvailable && !openclAvailable)
      throw std::runtime_error("neither SYCL nor OpenCL reported a compute device");
  }
  catch (const std::exception &error)
  {
    std::cerr << "Modern backend check failed: " << error.what() << '\n';
    SDL_Quit();
    return EXIT_FAILURE;
  }

  SDL_Quit();
  std::cout << "Modern backend check passed.\n";
  return EXIT_SUCCESS;
}
