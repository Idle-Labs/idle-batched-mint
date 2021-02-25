// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.6.12;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/Initializable.sol";

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IIdleTokenV3_1.sol";
import "./interfaces/IERC20Permit.sol";
import "./interfaces/IRelayRecipient.sol";

// import "hardhat/console.sol";

contract IdleBatchedMint is Initializable, OwnableUpgradeable, PausableUpgradeable, IRelayRecipient {
  using SafeERC20 for IERC20;
  using SafeMath for uint256;

  address constant feeTreasury = 0x69a62C24F16d4914a48919613e8eE330641Bcb94;
  address constant ecosystemFund = 0xb0aA1f98523Ec15932dd5fAAC5d86e57115571C7;

  // batchDeposits[user][batchId] = amount
  mapping (address => mapping (uint256 => uint256)) public batchDeposits;
  mapping (uint256 => uint256) public batchTotals;
  mapping (uint256 => uint256) public batchRedeemedTotals;
  uint256 public currBatch;
  address public idleToken;
  address public underlying;
  // end of V1 #######################

  address public trustedForwarder;
  string public override versionRecipient;
  // end of V2 #######################

  /*
   * require a function to be called through GSN only
   */
  modifier trustedForwarderOnly() {
    require(msg.sender == address(trustedForwarder), "Function can only be called through the trusted Forwarder");
    _;
  }

  function initialize(address _idleToken) public initializer {
    OwnableUpgradeable.__Ownable_init();
    PausableUpgradeable.__Pausable_init();
    idleToken = _idleToken;
    underlying = IIdleTokenV3_1(idleToken).token();
    IERC20(underlying).safeApprove(idleToken, uint256(-1));
  }

  function initTrustedForwarder(string memory _versionRecipient, address _trustedForwarder) public {
    require(trustedForwarder == address(0), "TF already initialized");
    versionRecipient = _versionRecipient;
    trustedForwarder = _trustedForwarder;
  }

  function setVersionRecipient(string memory _versionRecipient) public onlyOwner {
    versionRecipient = _versionRecipient;
  }

  function setTrustedForwarder(address _trustedForwarder) public onlyOwner {
    trustedForwarder = _trustedForwarder;
  }

  // User should approve this contract first to spend IdleTokens idleToken
  function deposit(uint256 amount) public whenNotPaused {
    depositForSender(msg.sender, amount);
  }

  function depositForSender(address sender, uint256 amount) internal {
    IERC20(underlying).safeTransferFrom(sender, address(this), amount);
    batchDeposits[sender][currBatch] = batchDeposits[sender][currBatch].add(amount);
    batchTotals[currBatch] = batchTotals[currBatch].add(amount);
  }

  function permitAndDeposit(uint256 amount, uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s) external whenNotPaused {
    IERC20Permit(underlying).permit(msg.sender, address(this), nonce, expiry, true, v, r, s);
    depositForSender(msg.sender, amount);
  }

  function relayedPermitAndDeposit(uint256 amount, uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s) external whenNotPaused trustedForwarderOnly {
    address sender = _forwardedMsgSender();
    IERC20Permit(underlying).permit(sender, address(this), nonce, expiry, true, v, r, s);
    depositForSender(sender, amount);
  }

  function permitEIP2612AndDeposit(uint256 amount, uint256 expiry, uint8 v, bytes32 r, bytes32 s) external whenNotPaused {
    IERC20Permit(underlying).permit(msg.sender, address(this), amount, expiry, v, r, s);
    depositForSender(msg.sender, amount);
  }

  function relayedPermitEIP2612AndDeposit(uint256 amount, uint256 expiry, uint8 v, bytes32 r, bytes32 s) external whenNotPaused {
    address sender = _forwardedMsgSender();
    IERC20Permit(underlying).permit(sender, address(this), amount, expiry, v, r, s);
    depositForSender(sender, amount);
  }

  function permitEIP2612AndDepositUnlimited(uint256 amount, uint256 expiry, uint8 v, bytes32 r, bytes32 s) external whenNotPaused {
    IERC20Permit(underlying).permit(msg.sender, address(this), uint256(-1), expiry, v, r, s);
    depositForSender(msg.sender, amount);
  }

  function withdraw(uint256 batchId) external whenNotPaused {
    require(batchId < currBatch, 'Batch id invalid');

    uint256 deposited = batchDeposits[msg.sender][batchId];
    uint256 batchBal = batchRedeemedTotals[batchId];
    uint256 share = deposited.mul(batchBal).div(batchTotals[batchId]);
    if (share > batchBal) {
      share = batchBal;
    }
    batchRedeemedTotals[batchId] = batchBal.sub(share);
    batchTotals[batchId] = batchTotals[batchId].sub(deposited);
    batchDeposits[msg.sender][batchId] = 0;
    IERC20(idleToken).safeTransfer(msg.sender, share);
  }

  function executeBatch(bool _skipRebalance) external whenNotPaused returns (uint256) {
    uint256 minted = IIdleTokenV3_1(idleToken).mintIdleToken(
      batchTotals[currBatch], _skipRebalance, address(0)
    );
    batchRedeemedTotals[currBatch] = minted;
    currBatch = currBatch.add(1);
  }

  function redeemGovToken() external whenNotPaused {
    _redeemGovToken();
  }

  function withdrawGovToken() external whenNotPaused {
    _withdrawGovToken();
  }

  function redeemAndWithdrawGovToken() external whenNotPaused {
    _redeemGovToken();
    _withdrawGovToken();
  }

  function _redeemGovToken() internal {
    IIdleTokenV3_1(idleToken).redeemIdleToken(0);
  }

  function _withdrawGovToken() internal {
    uint256[] memory amounts = IIdleTokenV3_1(idleToken).getGovTokensAmounts(0x0000000000000000000000000000000000000000);

    for (uint256 i = 0; i < amounts.length; i++) {
      address token = IIdleTokenV3_1(idleToken).govTokens(i);
      IERC20(token).safeTransfer(feeTreasury, IERC20(token).balanceOf(address(this)));
    }
  }

  function emergencyWithdrawToken(address _token, address _to) external onlyOwner {
    if (_token == underlying || _token == idleToken) {
      require(_to == feeTreasury || _to == ecosystemFund, "recipient must be feeTreasury or ecosystemFund");
    }
    IERC20(_token).safeTransfer(_to, IERC20(_token).balanceOf(address(this)));
  }

  function pause() external onlyOwner {
    _pause();
  }

  function isTrustedForwarder(address forwarder) public override view returns(bool) {
    return forwarder == trustedForwarder;
  }

  /**
   * return the sender of this call.
   * if the call came through our trusted forwarder, return the original sender.
   * otherwise, return `msg.sender`.
   * should be used in the contract anywhere instead of msg.sender
   */
  function _forwardedMsgSender() internal virtual view returns (address payable ret) {
    if (msg.data.length >= 24 && isTrustedForwarder(msg.sender)) {
      // At this point we know that the sender is a trusted forwarder,
      // so we trust that the last bytes of msg.data are the verified sender address.
      // extract sender address from the end of msg.data
      assembly {
        ret := shr(96,calldataload(sub(calldatasize(),20)))
      }
    } else {
      return msg.sender;
    }
  }
}
