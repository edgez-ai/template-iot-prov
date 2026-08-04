#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_mqtt_client.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

namespace {
constexpr char kTag[] = "iot_prov";
constexpr char kMqttNamespace[] = "mqtt";
constexpr char kMqttEndpoint[] = "mqtt-config";
constexpr char kMqttBrokerUri[] = "mqtts://mqtt.edgez.ai:8883";
constexpr EventBits_t kWifiConnected = BIT0;
constexpr EventBits_t kMqttConfigured = BIT1;

struct MqttConfig {
  char client_id[64];
  char username[37];
  char password[160];
  char project_id[64];
  char channel[81];
};

EventGroupHandle_t state_events;
esp_mqtt_client_handle_t mqtt_client;
MqttConfig mqtt_config{};
char provisioning_name[20]{};
char provisioning_pop[16]{};

bool valid_serial(const char *value) {
  if (!value) return false;
  const size_t length = std::strlen(value);
  if (length < 1 || length > 36) return false;
  for (size_t index = 0; index < length; ++index) {
    const char c = value[index];
    const bool alpha_numeric = (c >= 'A' && c <= 'Z') ||
                               (c >= 'a' && c <= 'z') ||
                               (c >= '0' && c <= '9');
    if (index == 0 && !alpha_numeric) return false;
    if (!alpha_numeric && c != '.' && c != '_' && c != ':' && c != '-') return false;
  }
  return true;
}

bool copy_json_string(cJSON *root, const char *key, char *output, size_t capacity) {
  cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
  if (!cJSON_IsString(item) || !item->valuestring) return false;
  const size_t length = std::strlen(item->valuestring);
  if (length == 0 || length >= capacity) return false;
  std::memcpy(output, item->valuestring, length + 1);
  return true;
}

esp_err_t save_mqtt_config(const MqttConfig &config) {
  nvs_handle_t handle;
  esp_err_t result = nvs_open(kMqttNamespace, NVS_READWRITE, &handle);
  if (result != ESP_OK) return result;
  const struct { const char *key; const char *value; } values[] = {
      {"client", config.client_id},
      {"username", config.username}, {"password", config.password},
      {"project", config.project_id}, {"channel", config.channel},
  };
  for (const auto &value : values) {
    result = nvs_set_str(handle, value.key, value.value);
    if (result != ESP_OK) break;
  }
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  return result;
}

bool load_nvs_string(nvs_handle_t handle, const char *key, char *output, size_t capacity) {
  size_t length = capacity;
  return nvs_get_str(handle, key, output, &length) == ESP_OK && output[0] != '\0';
}

bool load_mqtt_config() {
  nvs_handle_t handle;
  if (nvs_open(kMqttNamespace, NVS_READONLY, &handle) != ESP_OK) return false;
  const bool loaded =
      load_nvs_string(handle, "client", mqtt_config.client_id, sizeof(mqtt_config.client_id)) &&
      load_nvs_string(handle, "username", mqtt_config.username, sizeof(mqtt_config.username)) &&
      load_nvs_string(handle, "password", mqtt_config.password, sizeof(mqtt_config.password)) &&
      load_nvs_string(handle, "project", mqtt_config.project_id, sizeof(mqtt_config.project_id)) &&
      load_nvs_string(handle, "channel", mqtt_config.channel, sizeof(mqtt_config.channel));
  nvs_close(handle);
  return loaded && valid_serial(mqtt_config.username);
}

esp_err_t mqtt_config_handler(uint32_t, const uint8_t *input, ssize_t input_length,
                              uint8_t **output, ssize_t *output_length, void *) {
  if (!input || input_length <= 0 || input_length > 1024 || !output || !output_length) {
    return ESP_ERR_INVALID_ARG;
  }
  cJSON *root = cJSON_ParseWithLength(reinterpret_cast<const char *>(input), input_length);
  MqttConfig candidate{};
  bool valid = root &&
      copy_json_string(root, "clientId", candidate.client_id, sizeof(candidate.client_id)) &&
      copy_json_string(root, "username", candidate.username, sizeof(candidate.username)) &&
      copy_json_string(root, "password", candidate.password, sizeof(candidate.password)) &&
      copy_json_string(root, "projectId", candidate.project_id, sizeof(candidate.project_id)) &&
      copy_json_string(root, "channel", candidate.channel, sizeof(candidate.channel));
  valid = valid && valid_serial(candidate.username) &&
          std::strchr(candidate.channel, '/') == nullptr;

  esp_err_t result = valid ? save_mqtt_config(candidate) : ESP_ERR_INVALID_ARG;
  if (result == ESP_OK) {
    mqtt_config = candidate;
    xEventGroupSetBits(state_events, kMqttConfigured);
    ESP_LOGI(kTag, "MQTT credential stored for serial %s", mqtt_config.username);
  } else {
    ESP_LOGW(kTag, "Rejected MQTT provisioning data: %s", esp_err_to_name(result));
  }

  const char *response = result == ESP_OK ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"invalid mqtt config\"}";
  *output = static_cast<uint8_t *>(std::malloc(std::strlen(response) + 1));
  if (*output) std::memcpy(*output, response, std::strlen(response) + 1);
  if (!*output) result = ESP_ERR_NO_MEM;
  *output_length = *output ? std::strlen(response) : 0;
  cJSON_Delete(root);
  return result;
}

void make_provisioning_identity() {
  uint8_t mac[6]{};
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
  std::snprintf(provisioning_name, sizeof(provisioning_name), "IOT_%02X%02X%02X", mac[3], mac[4], mac[5]);
  std::snprintf(provisioning_pop, sizeof(provisioning_pop), "%02x%02x%02x%02x", mac[2], mac[3], mac[4], mac[5]);
}

void mqtt_event_handler(void *, esp_event_base_t, int32_t, void *);

void start_mqtt() {
  if (mqtt_client || !(xEventGroupGetBits(state_events) & kMqttConfigured)) return;
  esp_mqtt_client_config_t config{};
  config.broker.address.uri = kMqttBrokerUri;
  config.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
  config.credentials.client_id = mqtt_config.client_id;
  config.credentials.username = mqtt_config.username;
  config.credentials.authentication.password = mqtt_config.password;
  mqtt_client = esp_mqtt_client_init(&config);
  if (!mqtt_client) {
    ESP_LOGE(kTag, "Could not create MQTT client");
    return;
  }
  ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, nullptr));
  ESP_ERROR_CHECK(esp_mqtt_client_start(mqtt_client));
}

void mqtt_event_handler(void *, esp_event_base_t, int32_t event_id, void *) {
  if (event_id != MQTT_EVENT_CONNECTED) return;
  char topic[384]{};
  std::snprintf(topic, sizeof(topic), "projects/%s/devices/%s/telemetry/%s",
                mqtt_config.project_id, mqtt_config.username, mqtt_config.channel);
  const char *payload = "{\"status\":\"online\"}";
  const int message_id = esp_mqtt_client_publish(mqtt_client, topic, payload, 0, 1, 0);
  ESP_LOGI(kTag, "MQTT connected; published %s as message %d", topic, message_id);
}

void event_handler(void *, esp_event_base_t event_base, int32_t event_id, void *event_data) {
  if (event_base == WIFI_PROV_EVENT) {
    if (event_id == WIFI_PROV_CRED_FAIL) wifi_prov_mgr_reset_sm_state_on_failure();
    if (event_id == WIFI_PROV_END) wifi_prov_mgr_deinit();
    return;
  }
  if (event_base == WIFI_EVENT) {
    if (event_id == WIFI_EVENT_STA_START) esp_wifi_connect();
    if (event_id == WIFI_EVENT_STA_DISCONNECTED) {
      xEventGroupClearBits(state_events, kWifiConnected);
      esp_wifi_connect();
    }
    return;
  }
  if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
    xEventGroupSetBits(state_events, kWifiConnected);
    start_mqtt();
  }
}

void initialize_nvs() {
  esp_err_t result = nvs_flash_init();
  if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    result = nvs_flash_init();
  }
  ESP_ERROR_CHECK(result);
}
}  // namespace

extern "C" void app_main() {
  initialize_nvs();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  state_events = xEventGroupCreate();
  ESP_ERROR_CHECK(state_events ? ESP_OK : ESP_ERR_NO_MEM);
  if (load_mqtt_config()) xEventGroupSetBits(state_events, kMqttConfigured);

  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, event_handler, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, event_handler, nullptr));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, event_handler, nullptr));
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t wifi_config = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&wifi_config));

  wifi_prov_mgr_config_t provisioning_config{};
  provisioning_config.scheme = wifi_prov_scheme_ble;
  provisioning_config.scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM;
  ESP_ERROR_CHECK(wifi_prov_mgr_init(provisioning_config));

  bool wifi_provisioned = false;
  ESP_ERROR_CHECK(wifi_prov_mgr_is_provisioned(&wifi_provisioned));
  if (wifi_provisioned) {
    wifi_prov_mgr_deinit();
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
  } else {
    make_provisioning_identity();
    ESP_LOGI(kTag, "BLE provisioning service %s, PoP %s", provisioning_name, provisioning_pop);
    ESP_ERROR_CHECK(wifi_prov_mgr_endpoint_create(kMqttEndpoint));
    ESP_ERROR_CHECK(wifi_prov_mgr_start_provisioning(WIFI_PROV_SECURITY_1, provisioning_pop, provisioning_name, nullptr));
    ESP_ERROR_CHECK(wifi_prov_mgr_endpoint_register(kMqttEndpoint, mqtt_config_handler, nullptr));
    ESP_LOGI(kTag, "Send MQTT JSON to custom endpoint '%s' before applying Wi-Fi credentials", kMqttEndpoint);
  }
}
