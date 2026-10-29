targetScope = 'resourceGroup'

@minLength(36)
@maxLength(36)
param migrationId string
@minLength(64)
@maxLength(64)
param sourceArchiveSha256 string
param sshPublicKey string
param dataSourceUniqueId string
param auditSourceUniqueId string

var authorized = subscription().subscriptionId == '68eab0d1-ab81-4851-b2dd-173dede87582' && tenant().tenantId == '16b3c013-d300-468d-ac64-7eda0820b6d3' && resourceGroup().name == 'rg-opendots-pilot-scus'
var tags = {
  application: 'opendots'
  environment: 'pilot'
  managedBy: 'opendots-pilot-v1'
  profileId: 'pilot-scus-v1'
  migrationId: migrationId
  sourceArchiveSha256: sourceArchiveSha256
  stage: 'host'
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = if (authorized) {
  name: 'nsg-opendots-pilot-scus'
  location: 'southcentralus'
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'https-and-acme'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '10.43.0.4/32'
          destinationPortRanges: ['80', '443']
        }
      }
      {
        name: 'deny-other-inbound'
        properties: {
          priority: 4096
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = if (authorized) {
  name: 'vnet-opendots-pilot-scus'
  location: 'southcentralus'
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.43.0.0/24'] }
    subnets: [
      {
        name: 'app'
        properties: {
          addressPrefix: '10.43.0.0/24'
          networkSecurityGroup: { id: nsg!.id }
        }
      }
    ]
  }
}

resource pip 'Microsoft.Network/publicIPAddresses@2025-05-01' = if (authorized) {
  name: 'pip-opendots-pilot-scus'
  location: 'southcentralus'
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    ipTags: [
      { ipTagType: 'FirstPartyUsage', tag: '/Unprivileged' }
    ]
    dnsSettings: {
      domainNameLabel: 'opendots-7unu3az5tgmza-scus'
      domainNameLabelScope: 'ResourceGroupReuse'
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2025-05-01' = if (authorized) {
  name: 'nic-opendots-pilot-scus'
  location: 'southcentralus'
  tags: tags
  properties: {
    enableIPForwarding: false
    networkSecurityGroup: { id: nsg!.id }
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Static'
          privateIPAddress: '10.43.0.4'
          privateIPAddressVersion: 'IPv4'
          subnet: { id: '${vnet!.id}/subnets/app' }
          publicIPAddress: { id: pip!.id }
        }
      }
    ]
  }
}

resource data 'Microsoft.Compute/disks@2025-01-02' = if (authorized) {
  name: 'disk-opendots-pilot-scus-data'
  location: 'southcentralus'
  tags: union(tags, { expectedSourceUniqueId: dataSourceUniqueId })
  sku: { name: 'Standard_LRS' }
  properties: {
    creationData: {
      createOption: 'Copy'
      sourceResourceId: '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/resourceGroups/rg-opendots-pilot-scus/providers/Microsoft.Compute/snapshots/snap-opendots-scus-data-v1'
    }
    diskSizeGB: 32
    encryption: { type: 'EncryptionAtRestWithPlatformKey' }
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

resource audit 'Microsoft.Compute/disks@2025-01-02' = if (authorized) {
  name: 'disk-opendots-pilot-scus-os-audit'
  location: 'southcentralus'
  tags: union(tags, { expectedSourceUniqueId: auditSourceUniqueId })
  sku: { name: 'Standard_LRS' }
  properties: {
    creationData: {
      createOption: 'Copy'
      sourceResourceId: '/subscriptions/68eab0d1-ab81-4851-b2dd-173dede87582/resourceGroups/rg-opendots-pilot-scus/providers/Microsoft.Compute/snapshots/snap-opendots-scus-os-v1'
    }
    diskSizeGB: 30
    osType: 'Linux'
    hyperVGeneration: 'V2'
    securityProfile: { securityType: 'TrustedLaunch' }
    encryption: { type: 'EncryptionAtRestWithPlatformKey' }
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2025-11-01' = if (authorized) {
  name: 'vm-opendots-pilot-scus'
  location: 'southcentralus'
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: 'Standard_D2als_v7' }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    }
    storageProfile: {
      diskControllerType: 'NVMe'
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: '24.04.202610160'
      }
      osDisk: {
        name: 'disk-opendots-pilot-scus-os'
        createOption: 'FromImage'
        diskSizeGB: 32
        caching: 'ReadWrite'
        deleteOption: 'Detach'
        managedDisk: { storageAccountType: 'Standard_LRS' }
      }
      dataDisks: [
        {
          name: data!.name
          lun: 0
          createOption: 'Attach'
          caching: 'None'
          deleteOption: 'Detach'
          managedDisk: { id: data!.id }
        }
      ]
    }
    osProfile: {
      computerName: 'vm-opendots-pilot-scus'
      // The closed profile deliberately fixes this account; it is not an operator-selected parameter.
      #disable-next-line adminusername-should-not-be-literal
      adminUsername: 'opendots'
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            { path: '/home/opendots/.ssh/authorized_keys', keyData: sshPublicKey }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        { id: nic!.id, properties: { primary: true, deleteOption: 'Detach' } }
      ]
    }
  }
}

output resourceIds array = authorized ? [nsg!.id, vnet!.id, pip!.id, nic!.id, data!.id, audit!.id, vm!.id] : []
