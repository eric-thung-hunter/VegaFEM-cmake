// SPDX-License-Identifier: BSD-3-Clause
//
// A deliberately small, headless validation target for the modern backend.
// It exercises the same compiler/linker/runtime boundary that the full
// simulator will use: SDL2 for platform integration, Vulkan for rendering,
// and OpenCL for Intel GPU compute.  Keeping this check headless makes it
// suitable for hosted CI, where no physical Intel GPU is guaranteed.

#include <SDL.h>
#include <vulkan/vulkan.h>
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
    const bool openclAvailable = checkOpenCL();
    if (!openclAvailable)
      throw std::runtime_error("OpenCL reported no compute device");
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
