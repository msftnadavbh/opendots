targetScope = 'resourceGroup'

@description('Region preflighted for ACA zone redundancy, PostgreSQL HA/SKU/zones and Storage ZRS.')
@minLength(1)
@maxLength(64)
param location string

@description('3–10 lowercase ASCII letters/digits, starting with a letter; validate naming before deployment.')
@minLength(3)
@maxLength(10)
param namingPrefix string

@description('IPv4 VNet CIDR. Preflight containment, non-overlap and service-reserved ranges for all subnets.')
@minLength(9)
@maxLength(18)
param vnetCidr string

@description('Dedicated ACA subnet CIDR; /23 recommended, sized for the future replica/revision budget.')
@minLength(9)
@maxLength(18)
param acaSubnetCidr string

@description('Dedicated PostgreSQL subnet CIDR; /27 recommended, disjoint from ACA and private endpoints.')
@minLength(9)
@maxLength(18)
param postgresSubnetCidr string

@description('Undelegated private endpoint subnet CIDR; /27 recommended, disjoint from both delegated subnets.')
@minLength(9)
@maxLength(18)
param privateEndpointSubnetCidr string

@description('GeneralPurpose PostgreSQL SKU name, explicitly preflighted for HA in both selected zones.')
@minLength(1)
@maxLength(80)
param postgresSkuName string

@allowed(['1', '2', '3'])
@description('Primary logical availability zone; verify availability in this subscription/region.')
param postgresPrimaryZone string

@allowed(['1', '2', '3'])
@description('Standby logical availability zone; must differ from the primary and support the selected SKU.')
param postgresStandbyZone string

@description('Object ID of the reviewed Entra administrator GROUP in the deployment tenant, not a workload identity.')
@minLength(36)
@maxLength(36)
param entraAdminGroupObjectId string

@description('Display name of that Entra administrator group; verify its object ID and membership before deployment.')
@minLength(1)
@maxLength(256)
param entraAdminGroupDisplayName string

var storageName = '${namingPrefix}${uniqueString(resourceGroup().id, namingPrefix)}'
var postgresName = '${namingPrefix}-pg-${uniqueString(resourceGroup().id, namingPrefix)}'
var standbyZone = postgresPrimaryZone != postgresStandbyZone
  ? postgresStandbyZone
  : fail('PostgreSQL primary and standby availability zones must be distinct.')
var blobContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: '${namingPrefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetCidr]
    }
    subnets: [
      {
        name: 'aca'
        properties: {
          addressPrefix: acaSubnetCidr
          delegations: [
            {
              name: 'aca'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: postgresSubnetCidr
          delegations: [
            {
              name: 'postgres'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetCidr
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'private.postgres.database.azure.com'
  location: 'global'
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDns
  name: '${namingPrefix}-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = {
  name: '${namingPrefix}-aca'
  location: location
  properties: {
    environmentMode: 'WorkloadProfiles'
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: true
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'aca')
      internal: true
    }
    publicNetworkAccess: 'Disabled'
    // shortcut: no diagnostic sink or persisted logs, add a reviewed sink before application release.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
  }
}

// The domain is a runtime result; pass it into a same-RG module after environment creation.
module environmentDns './aca-dns.bicep' = {
  name: '${namingPrefix}-aca-dns'
  params: {
    domain: environment.properties.defaultDomain
    privateIp: environment.properties.staticIp
    vnetId: vnet.id
    linkName: '${namingPrefix}-vnet'
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: postgresName
  location: location
  sku: {
    name: postgresSkuName
    tier: 'GeneralPurpose'
  }
  properties: {
    version: '17'
    availabilityZone: postgresPrimaryZone
    highAvailability: {
      mode: 'ZoneRedundant'
      standbyAvailabilityZone: standbyZone
    }
    storage: {
      storageSizeGB: 128
      type: 'Premium_LRS'
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 35
      geoRedundantBackup: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
    network: {
      delegatedSubnetResourceId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'postgres')
      privateDnsZoneArmResourceId: postgresDns.id
    }
  }
  dependsOn: [postgresDnsLink]
}

resource postgresAdministrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: postgres
  name: entraAdminGroupObjectId
  properties: {
    principalName: entraAdminGroupDisplayName
    principalType: 'Group'
    tenantId: tenant().tenantId
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-08-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_ZRS'
  }
  properties: {
    isHnsEnabled: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-08-01' = {
  parent: storage
  name: 'default'
  properties: {
    // shortcut: versions have no lifecycle cost cap, approve retention/deletion policy before application release.
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource media 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-08-01' = {
  parent: blobService
  name: 'media'
  properties: {
    publicAccess: 'None'
  }
}

// This foundation targets Azure public cloud; the reviewed zone is intentionally pinned.
resource blobDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  #disable-next-line no-hardcoded-env-urls
  name: 'privatelink.blob.core.windows.net'
  location: 'global'
}

resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobDns
  name: '${namingPrefix}-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2025-05-01' = {
  name: '${namingPrefix}-blob-pe'
  location: location
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'private-endpoints')
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource blobDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-05-01' = {
  parent: blobPrivateEndpoint
  name: 'blob'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: blobDns.id
        }
      }
    ]
  }
}

resource workloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namingPrefix}-workload'
  location: location
}

resource mediaContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(media.id, workloadIdentity.id, blobContributorRoleId)
  scope: media
  properties: {
    roleDefinitionId: blobContributorRoleId
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output vnetId string = vnet.id
output acaSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'aca')
output postgresSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, 'postgres')
output privateEndpointSubnetId string = resourceId(
  'Microsoft.Network/virtualNetworks/subnets',
  vnet.name,
  'private-endpoints'
)
output acaEnvironmentId string = environment.id
output acaEnvironmentDomain string = environment.properties.defaultDomain
output acaEnvironmentPrivateIp string = environment.properties.staticIp
output postgresServerId string = postgres.id
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
output storageAccountId string = storage.id
output blobPrivateEndpointId string = blobPrivateEndpoint.id
output mediaContainerId string = media.id
output mediaEndpoint string = '${storage.properties.primaryEndpoints.blob}media'
output mediaContainerName string = media.name
output workloadIdentityId string = workloadIdentity.id
output workloadIdentityClientId string = workloadIdentity.properties.clientId
output workloadIdentityPrincipalId string = workloadIdentity.properties.principalId
