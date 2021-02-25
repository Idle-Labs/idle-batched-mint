// SPDX-License-Identifier: MIT

pragma solidity >=0.6.0 <0.8.0;

interface IProxyAdmin {
  function upgradeAndCall(address proxy, address implementation, bytes memory data) external;
}
