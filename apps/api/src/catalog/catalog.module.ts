import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import {
  CustomersController,
  OrdersController,
  ShippingCompaniesController,
} from './catalog.controller';

@Module({
  controllers: [OrdersController, ShippingCompaniesController, CustomersController],
  providers: [CatalogService],
})
export class CatalogModule {}
