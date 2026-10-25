targetScope = 'resourceGroup'

param domain string
param privateIp string
param vnetId string
param linkName string

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: domain
  location: 'global'
}

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: linkName
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource wildcard 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '*'
  properties: {
    ttl: 60
    aRecords: [
      {
        ipv4Address: privateIp
      }
    ]
  }
}
