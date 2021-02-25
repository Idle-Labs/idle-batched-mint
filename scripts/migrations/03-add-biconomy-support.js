const hre = require("hardhat");
const rl = require("readline");
const { HardwareSigner } = require("../../lib/HardwareSigner");
const LedgerSigner = HardwareSigner;
const { ethers, upgrades } = require("hardhat");
const { IdleBatchedContracts, IdleTokens } = require("../../lib");
const IdleBatchedMint = artifacts.require("IdleBatchedMint");
const IProxyAdmin = artifacts.require("IProxyAdmin");

const idleDeployerAddress = "0xe5dab8208c1f4cce15883348b72086dbace3e64b";
const forwarderVersionRecipient = "2.0.0-alpha.1+opengsn.test.recipient";

// FIXME: this is the address in KOVAN
const trustedForwarderAddress = "0x61F5832429D203977945414D4b391a348D162A32";

const prompt = (question) => {
  const r = rl.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  return new Promise((resolve, error) => {
    r.question(question, answer => {
      r.close()
      resolve(answer)
    });
  })
}

const check = (a, b, message) => {
  let [icon, symbol] = a === b ? ["✔️", "==="] : ["🚨🚨🚨", "!=="];
  console.log(`${icon}  `, a, symbol, b, message ? message : "");
}

async function main() {
  const network = hre.network.name;
  // let signer = new LedgerSigner(ethers.provider, null, "m/44'/60'/0'/0/0");
  let signer = (await ethers.getSigners())[0];
  let address = await signer.getAddress();
  const chainId = await web3.eth.getChainId();

  // in fork, we unlock the Idle deployer and send 10 ETH to it from accounts[0]
  if (chainId === 31337) {
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [idleDeployerAddress]}
    );
    signer = await ethers.provider.getSigner(idleDeployerAddress);
    address = idleDeployerAddress;

    const accounts = await web3.eth.getAccounts();
    await web3.eth.sendTransaction({ from: accounts[0], to: address, value: "10000000000000000000" })
  }

  console.log("runing on network", hre.network.name);
  console.log("chainId", chainId);
  console.log("deploying with account", address);
  console.log("account balance", web3.utils.fromWei(await web3.eth.getBalance(address)).toString(), "\n\n");

  const answer = await prompt("continue? [y/n]");
  if (answer !== "y" && answer !== "yes") {
    console.log("exiting...");
    process.exit(1);
  }

  console.log("starting...")

  const proxyAdmin = await IProxyAdmin.at("0x120508eB8f0895a7dE876cF2D49Bb04458C68a14");
  const idleBatchedMint = await IdleBatchedMint.new({ from: signer.address });
  console.log("IdleBatchedMint implementation deployed at", idleBatchedMint.address);

  for (token in IdleBatchedContracts[network]) {
    const proxyAddr = IdleBatchedContracts[network][token];
    const callData = web3.eth.abi.encodeFunctionCall({
      name: 'initTrustedForwarder(string,address)',
      type: 'function',
      inputs: [
        {
          type: 'string',
          name: '_versionRecipient'
        },
        {
          type: 'address',
          name: '_trustedForwarder'
        },
      ]
    }, [forwarderVersionRecipient, trustedForwarderAddress]);

    console.log(`upgrading IdleBatchedMint implementation for ${token} (proxy: ${proxyAddr})`);
    await proxyAdmin.upgradeAndCall(proxyAddr, idleBatchedMint.address, callData, { from: idleDeployerAddress });
    console.log(`Upgraded logic for Batch contract of ${token}`);
    console.log("***************************************************************************************");

    const proxy = await IdleBatchedMint.at(proxyAddr);

    const retrievedTrustedForwarderAddress = await proxy.trustedForwarder();
    check(retrievedTrustedForwarderAddress, trustedForwarderAddress, "checking trustedForwarder address");

    const retrievedVersionRecipient = await proxy.versionRecipient();
    check(retrievedVersionRecipient, forwarderVersionRecipient), "checking versionRecipient";
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
