idf_component_register(
  SRCS "main.cpp"
  INCLUDE_DIRS "."
  REQUIRES cjson mqtt esp_wifi network_provisioning nvs_flash esp_event esp_netif mbedtls
)
