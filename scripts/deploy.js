const hre = require("hardhat");
const rl = require("readline");
const { HardwareSigner } = require("../lib/HardwareSigner");
const LedgerSigner = HardwareSigner;
const { ethers, upgrades } = require("hardhat");
const { IdleTokens } = require("../lib");

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

async function main() {
  const network = hre.network.name;
  const signer = new LedgerSigner(ethers.provider, null, "m/44'/60'/0'/0/0");
  // const signer = (await ethers.getSigners())[0];
  const address = await signer.getAddress();
  const chainId = await web3.eth.getChainId();

  // in fork, we can send 10 ETH from accounts[0] to the ledger account
  if (chainId === 31337) {
    const accounts = await web3.eth.getAccounts();
    await web3.eth.sendTransaction({from: accounts[0], to: address, value: "10000000000000000000"})
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

  for (token in IdleTokens[network]) {
    const tokenAddress = IdleTokens[network][token];
    console.log(`deploying IdleBatchedMint for ${token} (${tokenAddress})`);
    const IdleBatchedMint = await ethers.getContractFactory("IdleBatchedMint", signer);
    const args = [tokenAddress];
    const proxy = await upgrades.deployProxy(IdleBatchedMint, args);
    await proxy.deployed();
    console.log(`${token} proxy deployed at`, proxy.address)
    console.log("***************************************************************************************");
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
