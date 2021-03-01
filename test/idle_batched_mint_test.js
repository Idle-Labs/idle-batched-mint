const { expectEvent, singletons, constants, BN, expectRevert } = require('@openzeppelin/test-helpers');
const { ethers, upgrades } = require("hardhat");
const { signPermit } = require("../lib");

const DAIMock = artifacts.require('DAIMock');
const IdleTokenMock = artifacts.require('IdleTokenMock');
const IdleBatchedMint = artifacts.require('IdleBatchedMint');
const TestForwarder = artifacts.require('TestForwarder');

const BNify = n => new BN(String(n));

contract('IdleBatchedMint', function ([_, owner, govOwner, manager, user1, user2, user3, user4]) {
  const checkBalance = async (who, token, amount) => {
    if (typeof amount === "string" || typeof amount === "number") {
      amount = BNify(amount);
    }

    BNify(await token.balanceOf(who)).should.be.bignumber.equal(amount);
  }

  const checkUserDeposit = async (bathedMint, user, batch, amount) => {
    if (typeof amount === "string" || typeof amount === "number") {
      amount = BNify(amount);
    }

    BNify(await batchedMint.batchDeposits(user, batch)).should.be.bignumber.equal(amount);
  }

  const checkBatchTotal = async (batch, amount) => {
    const batchBalance = await this.batchedMint.batchTotals(batch);
    batchBalance.toString().should.be.equal(amount);
  }

  beforeEach(async () => {
    this.one = new BN('1000000000000000000');
    this.DAIMock = await DAIMock.new({ from: owner });
    this.token = await IdleTokenMock.new(this.DAIMock.address, { from: owner });
    this.trustedForwarder = await TestForwarder.new();

    const signers = await ethers.getSigners();
    const contract = (await ethers.getContractFactory("IdleBatchedMint")).connect(signers[1]);
    const instance = await upgrades.deployProxy(contract, [this.token.address]);
    this.batchedMint = await IdleBatchedMint.at(instance.address);

    await this.batchedMint.initTrustedForwarder("2.0.0-alpha.1+opengsn.test.recipient", this.trustedForwarder.address);
  });

  it("initializes the contract", async () => {
    (await this.batchedMint.idleToken()).should.be.equal(this.token.address);
    (await this.batchedMint.underlying()).should.be.equal(this.DAIMock.address);
  });

  it("upgrades proxy", async () => {
    const signers = await ethers.getSigners();
    const contract = (await ethers.getContractFactory("IdleBatchedMint")).connect(signers[1]);
    const newInstance = await upgrades.upgradeProxy(this.batchedMint.address, contract, [this.token.address]);
  });

  it("creates batches", async () => {
    const deposit = async (user, amount) => {
      // transfer amount from owner to user
      await this.DAIMock.transfer(user, amount, { from: owner });
      // approve from user to contract
      await this.DAIMock.approve(this.batchedMint.address, amount, { from: user });
      // call deposit
      await this.batchedMint.deposit(amount, { from: user });
    }

    const permitAndDeposit = async (user, amount) => {
      const nonce = 0;
      const expiry = Math.round(new Date().getTime() / 1000 + 3600);
      const erc20Name = await this.DAIMock.name();
      const sig =  await signPermit(this.DAIMock.address, erc20Name, user, this.batchedMint.address, amount, nonce, expiry);
      const r = sig.slice(0, 66);
      const s = "0x" + sig.slice(66, 130);
      const v = "0x" + sig.slice(130, 132);

      // transfer amount from owner to user
      await this.DAIMock.transfer(user, amount, { from: owner });
      // call permitAndDeposit
      await this.batchedMint.permitAndDeposit(amount, nonce, expiry, v, r, s, { from: user });
    }

    const withdraw = async (user, batch, expectedAmount) => {
      const initialBalance = await this.token.balanceOf(user);
      await this.batchedMint.withdraw(batch, { from: user });
      const balanceAfter = await this.token.balanceOf(user);
      balanceAfter.toString().should.be.equal(initialBalance.add(BNify(expectedAmount)).toString());
    }

    await checkBalance(this.batchedMint.address, this.token, "0");
    await checkBalance(this.batchedMint.address, this.DAIMock, "0");

    // 3 users deposit
    await deposit(user1, 10);
    await deposit(user2, 5);
    await deposit(user3, 6);

    // check deposit for each user
    await checkUserDeposit(this.batchedMint, user1, 0, "10");
    await checkUserDeposit(this.batchedMint, user2, 0, "5");
    await checkUserDeposit(this.batchedMint, user3, 0, "6");

    // check total deposit and contract tokens balance
    await checkBatchTotal(0, "21");
    await checkBalance(this.batchedMint.address, this.token, "0");
    await checkBalance(this.batchedMint.address, this.DAIMock, "21");

    // execute batch 0
    await this.batchedMint.executeBatch(true);

    // check contract tokens balance
    await checkBalance(this.batchedMint.address, this.token, "21");
    await checkBalance(this.batchedMint.address, this.DAIMock, "0");
    await checkBalance(user1, this.token, "0");

    // user1 withdraws batch 0
    await withdraw(user1, 0, "10");

    // check user balance and contract balance
    await checkBalance(user1, this.token, "10");
    await checkBalance(this.batchedMint.address, this.token, "11");

    // user2 permitAndDeposit
    await permitAndDeposit(user2, 30);
    await checkUserDeposit(this.batchedMint, user2, 0, "5");
    await checkUserDeposit(this.batchedMint, user2, 1, "30");

    // user3 deposits to batch 1
    await permitAndDeposit(user3, 100);

    // execute batch 1
    await this.batchedMint.executeBatch(true);

    // user2 has 0 idle tokens
    await checkBalance(user2, this.token, "0");
    // contract has 141 idle tokens
    await checkBalance(this.batchedMint.address, this.token, "141");

    // user2 withdraws batch 1
    await withdraw(user2, 1, "30");
    // user2 deposit for batch 0 is still 5
    await checkUserDeposit(this.batchedMint, user2, 0, "5");
    // user2 deposit for batch 1 is 0
    await checkUserDeposit(this.batchedMint, user2, 1, "0");
    // user2 has 30 idle tokens
    await checkBalance(user2, this.token, "30");
    // contract has 111 idle tokens
    await checkBalance(this.batchedMint.address, this.token, "111");

    // user1 cannot withdraw again from batch 0
    await withdraw(user1, 0, "0");

    // user1 cannot withdraw from batch 1 without depositing
    await withdraw(user1, 1, "0");

    // execute empty batch 2
    await this.batchedMint.executeBatch(true);
  });

  it("withdraws govTokens", async () => {
    const govTokens = [];
    govTokens[0] = await DAIMock.new({ from: owner });
    govTokens[1] = await DAIMock.new({ from: owner });
    govTokens[2] = await DAIMock.new({ from: owner });

    await this.token.setGovTokens([
      govTokens[0].address,
      govTokens[1].address,
      govTokens[2].address,
    ]);

    // move gov tokens to contract
    await govTokens[0].transfer(this.batchedMint.address, 10, { from: owner });
    await govTokens[1].transfer(this.batchedMint.address, 20, { from: owner });
    await govTokens[2].transfer(this.batchedMint.address, 30, { from: owner });

    const feeTreasury = "0x69a62C24F16d4914a48919613e8eE330641Bcb94";

    // feeTreasury has 0 of each gov token
    (await govTokens[0].balanceOf(feeTreasury)).toString().should.be.equal("0");
    (await govTokens[1].balanceOf(feeTreasury)).toString().should.be.equal("0");
    (await govTokens[2].balanceOf(feeTreasury)).toString().should.be.equal("0");

    // anyone can call withdrawGovToken and send them to feeTreasury
    await this.batchedMint.withdrawGovToken({ from: user4 });

    // feeTreasury received gov tokens
    (await govTokens[0].balanceOf(feeTreasury)).toString().should.be.equal("10");
    (await govTokens[1].balanceOf(feeTreasury)).toString().should.be.equal("20");
    (await govTokens[2].balanceOf(feeTreasury)).toString().should.be.equal("30");
  });

  it("should fails if paused", async () => {
    const calls = {
      deposit: [0],
      withdraw: [0],
      executeBatch: [0],
      withdrawGovToken: [],
    }

    // deposit and execute batch to be sure batch 0 is available for withdraw
    await this.DAIMock.approve(this.batchedMint.address, 1, { from: owner });
    await this.batchedMint.deposit(1, { from: owner });
    await this.batchedMint.executeBatch(true);

    // all methods should work
    for (let method in calls) {
      const params = calls[method];
      await this.batchedMint[method](...params, { from: owner });
    }

    // pause
    await this.batchedMint.pause({ from: owner });
    (await this.batchedMint.paused()).should.be.equal(true);

    // all pausable methods should fail
    for (let method in calls) {
      try {
        const params = calls[method];
        await this.batchedMint[method](...params, { from: owner });
        throw("call should have failed");
      } catch (err) {
        err.should.match(/Pausable: paused/);
      }
    }
  });

  it("should deposit using a trusted forwarder", async () => {
    const user = user1;
    const amount = BNify("10");

    await checkBalance(this.batchedMint.address, this.token, "0");
    await checkBalance(this.batchedMint.address, this.DAIMock, "0");
    await checkBalance(user, this.token, "0");
    await checkBalance(user, this.DAIMock, "0");
    await checkUserDeposit(this.batchedMint.address, user, 0, "0");

    // transfer amount from owner to user
    await this.DAIMock.transfer(user, amount, { from: owner });
    await checkBalance(user, this.DAIMock, amount);

    const nonce = 0;
    const expiry = Math.round(new Date().getTime() / 1000 + 3600);
    const erc20Name = await this.DAIMock.name();
    const sig =  await signPermit(this.DAIMock.address, erc20Name, user, this.batchedMint.address, amount, nonce, expiry);
    const r = sig.slice(0, 66);
    const s = "0x" + sig.slice(66, 130);
    const v = "0x" + sig.slice(130, 132);

    const methodSig = "relayedPermitAndDeposit(uint256,uint256,uint256,uint8,bytes32,bytes32)";
    const data = web3.eth.abi.encodeParameters(
      ["uint256", "uint256", "uint256", "uint8", "bytes32", "bytes32"],
      [amount, nonce, expiry, v, r, s]
    )

    const tx = await this.trustedForwarder.execute(this.batchedMint.address, methodSig, data, { from: user });

    await checkBalance(this.batchedMint.address, this.DAIMock, amount);
    await checkUserDeposit(this.batchedMint.address, user, 0, amount);
  });
});
