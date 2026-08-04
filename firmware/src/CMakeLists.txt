idf_component_register(
  SRCS "main.cpp"
  INCLUDE_DIRS "."
  REQUIRES cjson mqtt esp_wifi wifi_provisioning nvs_flash esp_event esp_netif mbedtls
)
