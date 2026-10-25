targetScope = 'resourceGroup'

param tags object
param sshPublicKey string
// Historical public parameter remains pinned; governance has closed SSH, including this /32.
#disable-next-line no-unused-params
param operatorIpv4Cidr string

var location = 'eastus2'
var vmName = 'vm-opendots-pilot'
var suffix = uniqueString(resourceGroup().id)

resource nsg 'Microsoft.Network/networkSecurityGroups@2025-05-01' = {
  name: 'nsg-opendots-pilot'
  location: location
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
          destinationAddressPrefix: '*'
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

resource vnet 'Microsoft.Network/virtualNetworks@2025-05-01' = {
  name: 'vnet-opendots-pilot'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/24'] }
    subnets: [
      {
        name: 'app'
        properties: { addressPrefix: '10.42.0.0/24' }
      }
    ]
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2025-05-01' = {
  name: 'pip-opendots-pilot'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: 'opendots-${suffix}'
      domainNameLabelScope: 'ResourceGroupReuse'
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2025-05-01' = {
  name: 'nic-opendots-pilot'
  location: location
  tags: tags
  properties: {
    enableIPForwarding: false
    networkSecurityGroup: { id: nsg.id }
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          primary: true
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: '${vnet.id}/subnets/app' }
          publicIPAddress: { id: publicIp.id }
        }
      }
    ]
  }
}

resource dataDisk 'Microsoft.Compute/disks@2025-01-02' = {
  name: 'disk-opendots-pilot-data'
  location: location
  tags: tags
  sku: { name: 'StandardSSD_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: 32
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}

resource host 'Microsoft.Compute/virtualMachines@2025-11-01' = {
  name: vmName
  location: location
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
        name: 'disk-opendots-pilot-os'
        createOption: 'FromImage'
        deleteOption: 'Detach'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
      }
      dataDisks: [
        {
          lun: 0
          name: dataDisk.name
          createOption: 'Attach'
          caching: 'None'
          deleteOption: 'Detach'
          managedDisk: { id: dataDisk.id }
        }
      ]
    }
    osProfile: {
      computerName: vmName
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
        { id: nic.id, properties: { primary: true, deleteOption: 'Detach' } }
      ]
    }
  }
}

output vmPrincipalId string = host.identity.principalId
output vm object = {
  id: host.id
  name: host.name
  uniqueId: host.properties.vmId
  principalId: host.identity.principalId
  tenantId: host.identity.tenantId
  nicId: nic.id
  nsgId: nsg.id
  vnetId: vnet.id
  subnetId: '${vnet.id}/subnets/app'
  publicIpId: publicIp.id
  ipv4: publicIp.properties.ipAddress
  fqdn: publicIp.properties.dnsSettings.fqdn
  dataDiskId: dataDisk.id
  dataDiskUniqueId: dataDisk.properties.uniqueId
  osDiskId: resourceId('Microsoft.Compute/disks', 'disk-opendots-pilot-os')
}
